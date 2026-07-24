import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {HistoryController} from '../libs/Controller'
import {getHighlighter, onDidChangeTheme} from '../diff/SyntaxHighlighter'
import {formatDate, PKG_CONFIG, getIconPath} from '../utils'
import {
    computeLineDiff,
    computeInlineDiff,
    computeHiddenRegions,
    computeHunks,
    parseSnapshotDate,
    yieldToEventLoop,
} from '../diff/DiffEngine'
import {
    buildSideHtml,
    buildUnifiedHtml,
    ADD_HUNK_TITLE,
    REMOVE_HUNK_TITLE,
} from '../diff/DiffRenderer'

// ---------------------------------------------------------------------------
// TimelineProvider
// ---------------------------------------------------------------------------

const KEYBOARD_NAVIGATION_DEBOUNCE_MS = 300

export class TimelineProvider {
    private static active : TimelineProvider | undefined
    private panel         : vscode.WebviewPanel | undefined
    private controller    : HistoryController
    private extensionUri  : vscode.Uri
    private disposables   : vscode.Disposable[] = []

    // State for current session
    private snapshots               : string[] = []
    private snapshotIndex           : number = 0
    private currentFileUri          : vscode.Uri | undefined
    private currentFileContent      : string = ''
    private currentLanguageId       : string = 'plaintext'
    private renderMode              : 'side-by-side' | 'unified' = 'side-by-side'
    private _undoStacks             : Map<string, string[]> = new Map()
    private themeChangeSubscription : vscode.Disposable | undefined
    private lineHeightSubscription  : vscode.Disposable | undefined
    private navigationRenderTimer   : ReturnType<typeof setTimeout> | undefined
    private renderGeneration        : number = 0
    private treeProvider?           : HistoryTreeProvider
    private initialCursorLine       : number | undefined

    constructor(controller: HistoryController, extensionUri: vscode.Uri) {
        this.controller = controller
        this.extensionUri = extensionUri
        TimelineProvider.active = this
    }

    public setTreeProvider(provider: HistoryTreeProvider) {
        this.treeProvider = provider
    }

    public static zoomIn = () => TimelineProvider.active?.sendZoom('in')
    public static zoomOut = () => TimelineProvider.active?.sendZoom('out')
    public static resetZoom = () => TimelineProvider.active?.sendZoom('reset')
    public static undo = () => TimelineProvider.active?.requestUndo()

    private sendZoom(action: 'in' | 'out' | 'reset') {
        this.panel?.webview.postMessage({type: 'zoom', action})
    }

    private requestUndo() {
        if (this.panel) {
            this.panel.webview.postMessage({type: 'undo-command'})
        } else {
            void this.undoLastAction()
        }
    }

    private setActiveContext(active: boolean) {
        vscode.commands.executeCommand('setContext', 'localHistory:timelineActive', active)
    }

    /** Open timeline for the active editor or a specific file */
    async open() {
        const editor = vscode.window.activeTextEditor

        if (!editor) {
            vscode.window.showErrorMessage('No active editor to show timeline for.')

            return
        }

        const doc = editor.document
        const fileName = doc.fileName
        const settings = this.controller.getSettings(doc.uri)
        const fileProps = await this.controller.findAllHistory(fileName, settings, true)

        if (!fileProps.history || fileProps.history.length === 0) {
            vscode.window.showInformationMessage(`No history snapshots found for this file.`)

            return
        }

        // Reverse to newest-first (original is oldest-first)
        const allSnapshots = [...fileProps.history].reverse()
        this.snapshotIndex = 0
        this.currentFileUri = doc.uri
        this.currentFileContent = doc.getText()
        this.currentLanguageId = doc.languageId

        // Drop snapshots identical to current file content (right === left)
        this.snapshots = allSnapshots.filter((snapPath) => {
            try {
                return fs.readFileSync(snapPath, 'utf-8') !== this.currentFileContent
            } catch {
                return true
            }
        })

        if (this.snapshots.length === 0) {
            vscode.window.showInformationMessage(`No history snapshots with changes for this file.`)

            return
        }

        this.initialCursorLine = editor.selection.active.line + 1
        this.showPanel(doc.fileName)
        await this.renderSnapshot()
    }

    private showPanel(fileName: string) {
        fileName = path.basename(fileName)
        const title = `Local History Timeline : ${fileName}`

        TimelineProvider.active = this

        if (this.panel) {
            this.panel.title = title
            this.panel.reveal(vscode.ViewColumn.Active)
            this.setActiveContext(true)
            // Refresh content in case current file changed
            this.reloadCurrentContent().then(() => this.renderSnapshot())

            return
        }

        this.panel = vscode.window.createWebviewPanel(
            'localHistoryTimeline',
            title,
            vscode.ViewColumn.Active,
            {
                enableScripts           : true,
                retainContextWhenHidden : true,
                localResourceRoots      : [
                    vscode.Uri.joinPath(this.extensionUri, 'images'),
                    vscode.Uri.joinPath(this.extensionUri, 'timeline'),
                ],
            },
        )

        this.panel.webview.html = this.getBaseHtml()
        this.setActiveContext(true)

        this.panel.onDidChangeViewState((event) => {
            const panel = event.webviewPanel
            this.setActiveContext(panel.active)
            panel.webview.postMessage({type: 'viewState', active: panel.active, visible: panel.visible})
        }, null, this.disposables)
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
        this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables)

        // Refresh entire webview when theme changes - ensures fresh CSS
        // variables and re-initialize the SyntaxHighlighter from scratch.
        this.themeChangeSubscription = onDidChangeTheme(() => {
            vscode.window.showInformationMessage(`Please close & reopen the view for full syntax highlight support.`)

            if (this.panel) {
                this.panel.webview.html = this.getBaseHtml()
            }
        })
        this.lineHeightSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
            if (!this.panel) {
                return
            }

            if (event.affectsConfiguration('editor.lineHeight')) {
                this.panel.webview.html = this.getBaseHtml()
            }

            if (event.affectsConfiguration('diffEditor.hideUnchangedRegions') || event.affectsConfiguration(PKG_CONFIG)) {
                this.renderSnapshot()
            }
        })
    }

    private async renderSnapshot() {
        if (!this.panel || this.snapshots.length === 0) {
            return
        }

        const generation = ++this.renderGeneration
        const snapshotPath = this.snapshots[this.snapshotIndex]
        let snapshotContent: string

        try {
            snapshotContent = fs.readFileSync(snapshotPath, 'utf-8')
        } catch {
            vscode.window.showErrorMessage(`Failed to read snapshot: ${snapshotPath}`)

            return
        }

        // Let newer navigation messages invalidate this render before the
        // synchronous diff/highlighting work starts.
        const hl = await getHighlighter(this.currentLanguageId)

        if (generation !== this.renderGeneration || !this.panel) {
            return
        }

        // Compute diff
        const diff = await computeLineDiff(
            snapshotContent,
            this.currentFileContent,
            () => generation !== this.renderGeneration || !this.panel,
        )

        if (!diff) {
            return
        }

        const leftLines = diff[0]
        const rightLines = diff[1]
        const diffEditorConfig = vscode.workspace.getConfiguration('diffEditor')
        const hiddenRegions = computeHiddenRegions(
            leftLines,
            diffEditorConfig.get<boolean>('hideUnchangedRegions.enabled', false),
            Math.max(1, diffEditorConfig.get<number>('hideUnchangedRegions.minimumLineCount', 3)),
            Math.max(1, diffEditorConfig.get<number>('hideUnchangedRegions.contextLineCount', 3)),
        )

        const hunks = computeHunks(leftLines, rightLines)
        const hunkMap = new Map<number, number>()

        for (const [idx, hunk] of hunks.entries()) {
            for (let i = hunk.alignedStart; i < leftLines.length && leftLines[i].kind !== 'unchanged'; i++) {
                hunkMap.set(i, idx)
            }
        }

        for (let i = 0; i < Math.min(leftLines.length, rightLines.length); i++) {
            if (i % 128 === 0) {
                await yieldToEventLoop()

                if (generation !== this.renderGeneration || !this.panel) {
                    return
                }
            }

            if (leftLines[i].kind === 'removed' && rightLines[i].kind === 'added') {
                const [leftInline, rightInline] = computeInlineDiff(leftLines[i].content, rightLines[i].content)
                leftLines[i].inline = leftInline
                rightLines[i].inline = rightInline
            }
        }

        const highlightedLines = new Map<string, string>()
        const isUnified = this.renderMode === 'unified'

        const highlight = (line: string) => {
            let highlighted = highlightedLines.get(line)

            if (highlighted === undefined) {
                highlighted = hl(line)
                highlightedLines.set(line, highlighted)
            }

            return highlighted
        }

        const leftHtmlLines = isUnified
            ? []
            : buildSideHtml({
                lines        : leftLines, hiddenRegions, hunkMap, highlight,
                changedKind  : 'removed', emptyKind    : 'added',
                changedClass : 'diff-removed', action       : 'add', title        : ADD_HUNK_TITLE,
            })
        const rightHtmlLines = isUnified
            ? []
            : buildSideHtml({
                lines        : rightLines, hiddenRegions, hunkMap, highlight,
                changedKind  : 'added', emptyKind    : 'removed',
                changedClass : 'diff-added', action       : 'remove', title        : REMOVE_HUNK_TITLE,
            })
        const unifiedHtml = isUnified
            ? buildUnifiedHtml(leftLines, rightLines, highlight, hunkMap, hiddenRegions)
            : ''

        await yieldToEventLoop()

        if (generation !== this.renderGeneration || !this.panel) {
            return
        }

        const ext = path.extname(this.currentFileUri?.fsPath || '')

        this.panel.webview.postMessage({
            type              : 'render',
            leftHtml          : leftHtmlLines.join(''),
            rightHtml         : rightHtmlLines.join(''),
            unifiedHtml,
            mode              : this.renderMode,
            fileName          : path.basename(this.currentFileUri?.fsPath || ''),
            extension         : ext,
            initialCursorLine : this.initialCursorLine,
            ...this.getNavigationState(),
            hasChanges        : snapshotContent !== this.currentFileContent,
            hasUndo           : this.hasUndoContent(),
        })
    }

    private getNavigationState() {
        return {
            currentIndex  : this.snapshots.length - this.snapshotIndex,
            totalCount    : this.snapshots.length,
            hasPrev       : this.snapshotIndex < this.snapshots.length - 1,
            hasNext       : this.snapshotIndex > 0,
            snapshotDates : this.snapshots.map((snapshotPath) => {
                const date = parseSnapshotDate(snapshotPath)

                return date ? formatDate(date) : ''
            }),
            snapshotIndex : this.snapshotIndex,
        }
    }

    private async handleMessage(msg: any) {
        switch (msg.type) {
            case 'navigate': {
                const step = msg.direction === 'prev' ? 1 : msg.direction === 'next' ? -1 : 0
                const nextIndex = this.snapshotIndex + step

                if (step && nextIndex >= 0 && nextIndex < this.snapshots.length) {
                    this.snapshotIndex = nextIndex
                    this.renderGeneration++
                    this.initialCursorLine = undefined

                    if (msg.keyboard) {
                        this.scheduleNavigationRender()
                    } else {
                        await this.renderSnapshot()
                    }
                }

                break
            }

            case 'restore':
                this.initialCursorLine = undefined
                await this.restoreCurrentSnapshot()
                break

            case 'open-snapshot': {
                const snapPath = this.snapshots[this.snapshotIndex]

                if (snapPath) {
                    const uri = vscode.Uri.file(snapPath)
                    vscode.commands.executeCommand('vscode.open', uri)
                    this.treeProvider?.selectSnapshotFile(snapPath)
                }

                break
            }

            case 'goto':
                this.cancelNavigationRender()
                this.renderGeneration++
                this.initialCursorLine = undefined

                if (msg.index >= 0 && msg.index < this.snapshots.length && msg.index !== this.snapshotIndex) {
                    this.snapshotIndex = msg.index
                    await this.renderSnapshot()
                }

                break

            case 'ready':
                this.cancelNavigationRender()
                this.renderGeneration++
                this.renderMode = msg.mode === 'unified' ? 'unified' : 'side-by-side'
                await this.renderSnapshot()
                break

            case 'render-mode': {
                const mode = msg.mode === 'unified' ? 'unified' : 'side-by-side'

                if (mode !== this.renderMode) {
                    this.renderMode = mode
                    this.renderGeneration++
                    this.initialCursorLine = undefined
                    await this.renderSnapshot()
                }

                break
            }

            case 'refresh':
                this.renderGeneration++
                this.initialCursorLine = undefined
                await this.renderSnapshot()
                break

            case 'show-notification':
                vscode.window.showInformationMessage(msg.message)
                break

            case 'close':
                this.disposePanel()
                break

            case 'apply-hunk':
            case 'reject-hunk':
                this.panel?.webview.postMessage({type: 'action-result', applied: await this.applyHunk(msg.index)})
                break

            case 'apply-line':
                this.panel?.webview.postMessage({type: 'action-result', applied: await this.applyLine(msg.hunkIndex, msg.alignedIndex, msg.action)})
                break

            case 'undo':
                this.panel?.webview.postMessage({type: 'action-result', applied: await this.undoLastAction()})
                break
        }
    }

    private scheduleNavigationRender() {
        this.cancelNavigationRender()
        this.navigationRenderTimer = setTimeout(() => {
            this.navigationRenderTimer = undefined
            void this.renderSnapshot()
        }, KEYBOARD_NAVIGATION_DEBOUNCE_MS)
    }

    private cancelNavigationRender() {
        if (this.navigationRenderTimer) {
            clearTimeout(this.navigationRenderTimer)
            this.navigationRenderTimer = undefined
        }
    }

    private async applyHunk(hunkIndex: number): Promise<boolean> {
        if (!this.currentFileUri || this.snapshots.length === 0) {
            return false
        }

        const snapshotPath = this.snapshots[this.snapshotIndex]
        let snapshotContent: string

        try {
            snapshotContent = fs.readFileSync(snapshotPath, 'utf-8')
        } catch {
            return false
        }

        const diff = await computeLineDiff(snapshotContent, this.currentFileContent)

        if (!diff) {
            return false
        }

        const hunks = computeHunks(diff[0], diff[1])

        if (hunkIndex < 0 || hunkIndex >= hunks.length) {
            return false
        }

        const hunk = hunks[hunkIndex]

        const capturedUndo = this.captureUndoContent(this.currentFileContent)

        const edit = new vscode.WorkspaceEdit()
        const range = new vscode.Range(hunk.currentStart, 0, hunk.currentEnd, 0)
        const currentLineCount = this.currentFileContent.split('\n').length
        const replacement = hunk.snapshotContent + (hunk.currentEnd < currentLineCount ? '\n' : '')
        edit.replace(this.currentFileUri, range, replacement)

        if (!await vscode.workspace.applyEdit(edit)) {
            if (capturedUndo) {
                this.discardLastUndoContent()
            }

            return false
        }

        // Reload current content and re-render
        const doc = await vscode.workspace.openTextDocument(this.currentFileUri)
        this.currentFileContent = doc.getText()
        await this.renderSnapshot()

        return true
    }

    private async applyLine(hunkIndex: number, alignedIndex: number, action: 'add' | 'remove'): Promise<boolean> {
        if (!this.currentFileUri || this.snapshots.length === 0) {
            return false
        }

        let snapshotContent: string

        try {
            snapshotContent = fs.readFileSync(this.snapshots[this.snapshotIndex], 'utf-8')
        } catch {
            return false
        }

        const diff = await computeLineDiff(snapshotContent, this.currentFileContent)

        if (!diff) {
            return false
        }

        const [leftLines, rightLines] = diff
        const hunks = computeHunks(leftLines, rightLines)

        if (hunkIndex < 0 || hunkIndex >= hunks.length) {
            return false
        }

        const hunk = hunks[hunkIndex]
        let currentOffset = 0

        for (let i = hunk.alignedStart; i < leftLines.length && leftLines[i].kind !== 'unchanged'; i++) {
            const isCurrentLine = rightLines[i].kind === 'added'

            if (i === alignedIndex) {
                const targetLine = hunk.currentStart + currentOffset
                const capturedUndo = this.captureUndoContent(this.currentFileContent)
                const edit = new vscode.WorkspaceEdit()

                if (action === 'add') {
                    const lineContent = leftLines[i].content

                    if (isCurrentLine) {
                        edit.replace(this.currentFileUri, new vscode.Range(targetLine, 0, targetLine + 1, 0), lineContent + '\n')
                    } else {
                        edit.insert(this.currentFileUri, new vscode.Position(targetLine, 0), lineContent + '\n')
                    }
                } else {
                    edit.delete(this.currentFileUri, new vscode.Range(targetLine, 0, targetLine + 1, 0))
                }

                if (!await vscode.workspace.applyEdit(edit)) {
                    if (capturedUndo) {
                        this.discardLastUndoContent()
                    }

                    return false
                }

                this.currentFileContent = (await vscode.workspace.openTextDocument(this.currentFileUri)).getText()
                await this.renderSnapshot()

                return true
            }

            if (isCurrentLine) {
                currentOffset++
            }
        }

        return false
    }

    private async undoLastAction(): Promise<boolean> {
        if (!this.currentFileUri || !this.hasUndoContent()) {
            vscode.window.showInformationMessage(`Nothing to undo.`)

            return false
        }

        let undoContent: string | null

        try {
            undoContent = this.readUndoContent()
        } catch {
            this.discardLastUndoContent()
            await this.renderSnapshot()

            return false
        }

        if (undoContent === null) {
            this.discardLastUndoContent()
            await this.renderSnapshot()

            return false
        }

        const edit = new vscode.WorkspaceEdit()
        const doc = await vscode.workspace.openTextDocument(this.currentFileUri)
        const fullRange = new vscode.Range(0, 0, doc.lineCount, 0)
        edit.replace(this.currentFileUri, fullRange, undoContent)
        const applied = await vscode.workspace.applyEdit(edit)

        if (!applied) {
            return false
        }

        this.discardLastUndoContent()
        this.currentFileContent = (await vscode.workspace.openTextDocument(this.currentFileUri)).getText()
        await this.renderSnapshot()

        return true
    }

    private isFileBackedUndoEnabled(): boolean {
        return vscode.workspace.getConfiguration('localHistory').get<boolean>('fileBackedUndo', true)
    }

    private hasUndoContent(): boolean {
        return this.isFileBackedUndoEnabled() && this.getUndoStack().length > 0
    }

    private captureUndoContent(content: string): boolean {
        if (!this.isFileBackedUndoEnabled()) {
            return false
        }

        try {
            const undoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-history-undo-'))
            const undoPath = path.join(undoDir, 'content.txt')

            fs.writeFileSync(undoPath, content, 'utf-8')
            this.getUndoStack().push(undoPath)

            return true
        } catch {
            vscode.window.showWarningMessage('Failed to write file-backed undo copy; undo will be unavailable for this change.')

            return false
        }
    }

    private readUndoContent(): string | null {
        const undoStack = this.getUndoStack()
        const undoPath = undoStack[undoStack.length - 1]

        if (!undoPath) {
            return null
        }

        return fs.readFileSync(undoPath, 'utf-8')
    }

    private discardLastUndoContent() {
        const undoStack = this.getUndoStack()
        const undoPath = undoStack.pop()

        if (undoPath) {
            fs.rmSync(path.dirname(undoPath), {force: true, recursive: true})
        }
    }

    private getUndoStack(): string[] {
        const fileKey = this.currentFileUri?.toString()

        if (!fileKey) {
            return []
        }

        let undoStack = this._undoStacks.get(fileKey)

        if (!undoStack) {
            undoStack = []
            this._undoStacks.set(fileKey, undoStack)
        }

        return undoStack
    }

    private clearUndoContent() {
        for (const undoStack of this._undoStacks.values()) {
            for (const undoPath of undoStack) {
                fs.rmSync(path.dirname(undoPath), {force: true, recursive: true})
            }
        }

        this._undoStacks.clear()
    }

    /** Clean up any stale undo tmp dirs from past sessions (crashes, etc.) */
    public static cleanupAllUndoTmp() {
        const tmpDir = os.tmpdir()

        try {
            const entries = fs.readdirSync(tmpDir)

            for (const entry of entries) {
                if (entry.startsWith('local-history-undo-')) {
                    const fullPath = path.join(tmpDir, entry)

                    try {
                        fs.rmSync(fullPath, {force: true, recursive: true})
                    } catch {
                        // best-effort; ignore files we can't remove
                    }
                }
            }
        } catch {
            // best-effort; if we can't read tmpdir, skip cleanup
        }
    }

    private async restoreCurrentSnapshot() {
        const snapshotPath = this.snapshots[this.snapshotIndex]

        if (!snapshotPath || !this.currentFileUri) {
            return
        }

        const srcUri = vscode.Uri.file(snapshotPath)

        vscode.window
            .showInformationMessage(
                `Restore snapshot from ${formatDate(parseSnapshotDate(snapshotPath) || new Date())}?`,
                {modal: true, detail: `This will overwrite the current file.`},
                {title: 'Restore', isCloseAffordance: false},
                {title: 'Cancel', isCloseAffordance: true},
            )
            .then(async(choice) => {
                if (choice?.title === 'Restore') {
                    try {
                        await this.controller.restore(srcUri)

                        // Refresh current content
                        if (this.currentFileUri) {
                            const doc = await vscode.workspace.openTextDocument(this.currentFileUri)
                            this.currentFileContent = doc.getText()
                            await this.renderSnapshot()
                        }
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Restore failed: ${err.message || err}`)
                    }
                }
            })
    }

    private getBaseHtml(): string {
        const defaultView = vscode.workspace.getConfiguration('localHistory').get<string>('defaultView', 'side-by-side')
        this.renderMode = defaultView === 'unified' ? 'unified' : 'side-by-side'
        const breakpoint = vscode.workspace.getConfiguration('diffEditor').get<number>('renderSideBySideInlineBreakpoint', 900)
        const editorLineHeight = vscode.workspace.getConfiguration('editor').get<number>('lineHeight', 0)
        const lineHeight = editorLineHeight > 0 ? `${editorLineHeight}px` : '1.5em'
        const webview = this.panel?.webview

        if (!webview) {
            return ''
        }

        const mediaUri = vscode.Uri.joinPath(this.extensionUri, 'timeline')
        const htmlPath = path.join(mediaUri.fsPath, 'index.html')
        const html = fs.readFileSync(htmlPath, 'utf-8')

        return html
            .replace(/__STYLE_URI__/g, webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'style.css')).toString())
            .replace(/__SCRIPT_URI__/g, webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'script.js')).toString())
            .replace(/__SCROLL_TOP_ICON_URI__/g, getIconPath(webview, this.extensionUri, 'sort-up-filled.svg'))
            .replace(/__OPEN_FILE_ICON_URI__/g, getIconPath(webview, this.extensionUri, 'exit-pip-outline.svg'))
            .replace(/__PREV_NAV_ICON_URI__/g, getIconPath(webview, this.extensionUri, 'chevron-left-outline.svg'))
            .replace(/__NEXT_NAV_ICON_URI__/g, getIconPath(webview, this.extensionUri, 'chevron-right-outline.svg'))
            .replace(/__SEARCH_PREV_ICON_URI__/g, getIconPath(webview, this.extensionUri, 'chevron-left-outline.svg'))
            .replace(/__SEARCH_NEXT_ICON_URI__/g, getIconPath(webview, this.extensionUri, 'chevron-right-outline.svg'))
            .replace(/__SEARCH_CLOSE_ICON_URI__/g, getIconPath(webview, this.extensionUri, 'x-outline.svg'))
            .replace(/__CLOSE_ICON_URI__/g, getIconPath(webview, this.extensionUri, 'x-outline.svg'))
            .replace(/__PIN_ICON_URI__/g, getIconPath(webview, this.extensionUri, 'pin-rotate-outline.svg'))
            .replace(/__CSP_SOURCE__/g, webview.cspSource)
            .replace(/__BREAKPOINT__/g, String(breakpoint))
            .replace(/__INITIAL_UNIFIED__/g, String(defaultView === 'unified'))
            .replace(/__LINE_HEIGHT__/g, lineHeight)
            .replace(/__CONTEXT_LINES__/g, String(Math.max(1, vscode.workspace.getConfiguration('diffEditor').get<number>('hideUnchangedRegions.contextLineCount', 3))))
    }

    private dispose() {
        this.cancelNavigationRender()
        this.themeChangeSubscription?.dispose()
        this.themeChangeSubscription = undefined
        this.lineHeightSubscription?.dispose()
        this.lineHeightSubscription = undefined
        this.clearUndoContent()
        this.panel = undefined
        this.snapshots = []
        this.snapshotIndex = 0
        this.currentFileContent = ''
        this.currentFileUri = undefined
        this.initialCursorLine = undefined
        this.setActiveContext(false)

        if (TimelineProvider.active === this) {
            TimelineProvider.active = undefined
        }
    }

    private async reloadCurrentContent() {
        if (this.currentFileUri) {
            try {
                const doc = await vscode.workspace.openTextDocument(this.currentFileUri)
                this.currentFileContent = doc.getText()
            } catch {
                // keep existing content if file is gone
            }
        }
    }

    /** Public dispose for cleanup */
    public disposePanel() {
        this.cancelNavigationRender()
        this.clearUndoContent()

        if (this.panel) {
            this.panel.dispose()
            this.panel = undefined
        }
    }
}

// ---------------------------------------------------------------------------
// Re-export for extension.ts
// ---------------------------------------------------------------------------

import HistoryTreeProvider from './HistoryTreeProvider'
