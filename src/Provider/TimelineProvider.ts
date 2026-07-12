import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {HistoryController} from './Controller'
import {getHighlighter, onDidChangeTheme} from './SyntaxHighlighter'
import {formatDate, PKG_CONFIG} from '../utils'

// ---------------------------------------------------------------------------
// LCS-based line diff
// ---------------------------------------------------------------------------
interface DiffLine {
    kind    : 'added' | 'removed' | 'unchanged'
    content : string
    inline? : InlineDiffPart[]
}

interface InlineDiffPart {
    kind    : 'added' | 'removed' | 'unchanged'
    content : string
}

type InlineDiff = [InlineDiffPart[], InlineDiffPart[]]

function lcsBacktrack(
    table: number[][],
    oldLines: string[],
    newLines: string[],
    i: number,
    j: number,
    result: DiffLine[][],
): void {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        lcsBacktrack(table, oldLines, newLines, i - 1, j - 1, result)
        result[0].push({kind: 'unchanged', content: oldLines[i - 1]})
        result[1].push({kind: 'unchanged', content: newLines[j - 1]})
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
        lcsBacktrack(table, oldLines, newLines, i, j - 1, result)
        result[0].push({kind: 'added', content: ''})
        result[1].push({kind: 'added', content: newLines[j - 1]})
    } else if (i > 0 && (j === 0 || table[i][j - 1] < table[i - 1][j])) {
        lcsBacktrack(table, oldLines, newLines, i - 1, j, result)
        result[0].push({kind: 'removed', content: oldLines[i - 1]})
        result[1].push({kind: 'removed', content: ''})
    }
}

function computeLineDiff(leftText: string, rightText: string): DiffLine[][] {
    const leftLines = leftText.split('\n')
    const rightLines = rightText.split('\n')

    if (leftText === rightText) {
        return [
            leftLines.map((content) => ({kind: 'unchanged', content})),
            rightLines.map((content) => ({kind: 'unchanged', content})),
        ]
    }

    let prefixLength = 0

    while (
        prefixLength < leftLines.length
        && prefixLength < rightLines.length
        && leftLines[prefixLength] === rightLines[prefixLength]
    ) {
        prefixLength++
    }

    let suffixLength = 0

    while (
        suffixLength < leftLines.length - prefixLength
        && suffixLength < rightLines.length - prefixLength
        && leftLines[leftLines.length - suffixLength - 1] === rightLines[rightLines.length - suffixLength - 1]
    ) {
        suffixLength++
    }

    const middleLeftLines = leftLines.slice(prefixLength, leftLines.length - suffixLength)
    const middleRightLines = rightLines.slice(prefixLength, rightLines.length - suffixLength)
    const n = middleLeftLines.length
    const m = middleRightLines.length

    // Build LCS table
    const table: number[][] = Array.from({length: n + 1}, () => new Array(m + 1).fill(0))

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            table[i][j] = middleLeftLines[i - 1] === middleRightLines[j - 1]
                ? table[i - 1][j - 1] + 1
                : Math.max(table[i - 1][j], table[i][j - 1])
        }
    }

    const result: DiffLine[][] = [[], []]
    lcsBacktrack(table, middleLeftLines, middleRightLines, n, m, result)

    const aligned: DiffLine[][] = [[], []]

    for (let i = 0; i < result[0].length;) {
        if (result[0][i].kind === 'unchanged') {
            aligned[0].push(result[0][i])
            aligned[1].push(result[1][i])
            i++
            continue
        }

        const removed: string[] = []
        const added: string[] = []

        while (i < result[0].length && result[0][i].kind !== 'unchanged') {
            if (result[0][i].kind === 'removed') {
                removed.push(result[0][i].content)
            }

            if (result[1][i].kind === 'added') {
                added.push(result[1][i].content)
            }

            i++
        }

        for (let j = 0; j < Math.max(removed.length, added.length); j++) {
            aligned[0].push(j < removed.length
                ? {kind: 'removed', content: removed[j]}
                : {kind: 'added', content: ''})
            aligned[1].push(j < added.length
                ? {kind: 'added', content: added[j]}
                : {kind: 'removed', content: ''})
        }
    }

    const prefix = leftLines.slice(0, prefixLength)
    const suffixStartLeft = leftLines.length - suffixLength
    const suffixStartRight = rightLines.length - suffixLength

    return [
        prefix.map((content) => ({kind: 'unchanged', content}))
            .concat(aligned[0])
            .concat(leftLines.slice(suffixStartLeft).map((content) => ({kind: 'unchanged', content}))),
        rightLines.slice(0, prefixLength).map((content) => ({kind: 'unchanged', content}))
            .concat(aligned[1])
            .concat(rightLines.slice(suffixStartRight).map((content) => ({kind: 'unchanged', content}))),
    ]
}

function appendInlinePart(parts: InlineDiffPart[], kind: InlineDiffPart['kind'], content: string): void {
    if (!content) {
        return
    }

    const previous = parts[parts.length - 1]

    if (previous?.kind === kind) {
        previous.content += content
    } else {
        parts.push({kind, content})
    }
}

function tokenizeInlineText(text: string): string[] {
    return text.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? []
}

function findInlineBounds(left: string[], right: string[]): [number, number] {
    let prefixLength = 0

    while (prefixLength < left.length && prefixLength < right.length && left[prefixLength] === right[prefixLength]) {
        prefixLength++
    }

    let suffixLength = 0

    while (
        suffixLength < left.length - prefixLength
        && suffixLength < right.length - prefixLength
        && left[left.length - suffixLength - 1] === right[right.length - suffixLength - 1]
    ) {
        suffixLength++
    }

    return [prefixLength, suffixLength]
}

function buildInlineDiffTable(left: string[], right: string[]): number[][] {
    // ponytail: word LCS is O(n*m); use a bounded diff algorithm if long lines become slow.
    const table: number[][] = Array.from({length: left.length + 1}, () => new Array(right.length + 1).fill(0))

    for (let i = 1; i <= left.length; i++) {
        for (let j = 1; j <= right.length; j++) {
            table[i][j] = left[i - 1] === right[j - 1]
                ? table[i - 1][j - 1] + 1
                : Math.max(table[i - 1][j], table[i][j - 1])
        }
    }

    return table
}

function appendInlineOperations(result: InlineDiff, operations: DiffLine[][]): void {
    for (let i = 0; i < operations[0].length; i++) {
        const leftPart = operations[0][i]
        const rightPart = operations[1][i]

        if (leftPart.kind === 'unchanged') {
            appendInlinePart(result[0], 'unchanged', leftPart.content)
            appendInlinePart(result[1], 'unchanged', rightPart.content)
        } else if (leftPart.kind === 'removed') {
            appendInlinePart(result[0], 'removed', leftPart.content)
        } else {
            appendInlinePart(result[1], 'added', rightPart.content)
        }
    }
}

function computeInlineDiff(leftText: string, rightText: string): InlineDiff {
    const left = tokenizeInlineText(leftText)
    const right = tokenizeInlineText(rightText)
    const [prefixLength, suffixLength] = findInlineBounds(left, right)
    const leftMiddle = left.slice(prefixLength, left.length - suffixLength)
    const rightMiddle = right.slice(prefixLength, right.length - suffixLength)
    const table = buildInlineDiffTable(leftMiddle, rightMiddle)
    const operations: DiffLine[][] = [[], []]
    lcsBacktrack(table, leftMiddle, rightMiddle, leftMiddle.length, rightMiddle.length, operations)

    const result: InlineDiff = [[], []]
    appendInlinePart(result[0], 'unchanged', left.slice(0, prefixLength).join(''))
    appendInlinePart(result[1], 'unchanged', right.slice(0, prefixLength).join(''))
    appendInlineOperations(result, operations)

    const suffix = left.slice(left.length - suffixLength).join('')
    appendInlinePart(result[0], 'unchanged', suffix)
    appendInlinePart(result[1], 'unchanged', suffix)

    return result
}

interface HiddenRegion {
    start : number
    count : number
}

interface HiddenRegions {
    starts      : Map<number, HiddenRegion>
    lineRegions : Map<number, HiddenRegion>
}

const ADD_HUNK_TITLE    = 'Add this change'
const REMOVE_HUNK_TITLE = 'Remove this change'
const KEYBOARD_NAVIGATION_DEBOUNCE_MS = 300

function computeHiddenRegions(lines: DiffLine[], enabled: boolean, minimumLineCount: number, contextLineCount: number): HiddenRegions {
    const starts = new Map<number, HiddenRegion>()
    const lineRegions = new Map<number, HiddenRegion>()

    if (!enabled) {
        return {starts, lineRegions}
    }

    let runStart = 0

    while (runStart < lines.length) {
        if (lines[runStart].kind !== 'unchanged') {
            runStart++
            continue
        }

        let runEnd = runStart

        while (runEnd < lines.length && lines[runEnd].kind === 'unchanged') {
            runEnd++
        }

        const runLength = runEnd - runStart
        const atStart = runStart === 0
        const atEnd = runEnd === lines.length

        if (atStart && atEnd) {
            if (runLength >= minimumLineCount) {
                const region = {start: runStart, count: runLength}
                starts.set(runStart, region)

                for (let i = runStart; i < runEnd; i++) {
                    lineRegions.set(i, region)
                }
            }

            runStart = runEnd
            continue
        }

        const hiddenLength = atStart || atEnd
            ? runLength - contextLineCount
            : runLength - contextLineCount * 2

        if (hiddenLength >= minimumLineCount) {
            const start = atStart ? runStart : runStart + contextLineCount
            const count = hiddenLength
            const region = {start, count}

            starts.set(start, region)

            for (let i = start; i < start + count; i++) {
                lineRegions.set(i, region)
            }
        }

        runStart = runEnd
    }

    return {starts, lineRegions}
}

// ---------------------------------------------------------------------------
// Hunk computation for apply-changes
// ---------------------------------------------------------------------------
interface Hunk {
    snapshotContent : string
    snapshotStart   : number
    snapshotEnd     : number
    currentContent  : string
    currentStart    : number
    currentEnd      : number
    alignedStart    : number
}

function computeHunks(leftLines: DiffLine[], rightLines: DiffLine[]): Hunk[] {
    const hunks: Hunk[] = []
    let snapLine = 0
    let currLine = 0
    let i = 0

    while (i < leftLines.length) {
        if (leftLines[i].kind === 'unchanged') {
            snapLine++
            currLine++
            i++
            continue
        }

        const alignedStart = i
        const hunkSnapStart = snapLine
        const hunkCurrStart = currLine
        const snapLines: string[] = []
        const currLines: string[] = []

        while (i < leftLines.length && leftLines[i].kind !== 'unchanged') {
            if (leftLines[i].kind === 'removed') {
                snapLines.push(leftLines[i].content)
                snapLine++
            }

            if (rightLines[i].kind === 'added') {
                currLines.push(rightLines[i].content)
                currLine++
            }

            i++
        }

        if (snapLines.length > 0 || currLines.length > 0) {
            hunks.push({
                snapshotContent : snapLines.join('\n'),
                snapshotStart   : hunkSnapStart,
                snapshotEnd     : hunkSnapStart + snapLines.length,
                currentContent  : currLines.join('\n'),
                currentStart    : hunkCurrStart,
                currentEnd      : hunkCurrStart + currLines.length,
                alignedStart,
            })
        }
    }

    return hunks
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function renderHiddenRegion(region: HiddenRegion): string {
    const title = `Show ${region.count} unchanged lines`

    return `<div class="line unchanged-region clickable-region" data-region="${region.start}" data-count="${region.count}" data-tooltip="${title}" aria-label="${title}" role="button" tabindex="0"><span class="hidden-label" data-region-label="${region.start}">${title}</span></div>`
}

function renderHiddenLine(dl: DiffLine, lineNumber: number, region: HiddenRegion, highlight: (s: string) => string): string {
    return `<div class="line unchanged-hidden" data-region="${region.start}"><span class="ln-num">${lineNumber}</span><span class="ln">${highlight(dl.content)}</span></div>`
}

function renderInlineDiff(content: string, parts: InlineDiffPart[] | undefined, highlight: (s: string) => string): string {
    if (!parts) {
        return highlight(content)
    }

    return parts.map((part) => part.kind === 'unchanged' || /^\s+$/u.test(part.content)
        ? highlight(part.content)
        : `<span class="inline-diff-${part.kind}">${highlight(part.content)}</span>`).join('')
}

function buildSideHtml(
    lines: DiffLine[],
    hiddenRegions: HiddenRegions,
    hunkMap: Map<number, number>,
    highlight: (s: string) => string,
    changedKind: 'added' | 'removed',
    emptyKind: 'added' | 'removed',
    changedClass: string,
    action: 'add' | 'remove',
    title: string,
): string[] {
    return lines.flatMap((dl, i) => {
        const hiddenRegion = hiddenRegions.starts.get(i)
        const hiddenRegionAtLine = hiddenRegions.lineRegions.get(i)
        const out: string[] = hiddenRegion ? [renderHiddenRegion(hiddenRegion)] : []

        if (hiddenRegionAtLine) {
            out.push(renderHiddenLine(dl, i + 1, hiddenRegionAtLine, highlight))

            return out
        }

        const cls = dl.kind === changedKind ? ` ${changedClass}` : dl.kind === emptyKind ? ' diff-empty' : ''
        const hunkIdx = hunkMap.get(i)
        const hunkTitle = hunkIdx === undefined ? '' : title
        const attrs = hunkIdx === undefined
            ? ''
            : ` data-hunk="${hunkIdx}" data-action="${action}" data-tooltip="${hunkTitle}" aria-label="${hunkTitle}" role="button" tabindex="0"`

        out.push(`<div class="line${cls}${hunkIdx === undefined ? '' : ' clickable-hunk'}"${attrs}><span class="ln-num">${i + 1}</span><span class="ln">${renderInlineDiff(dl.content, dl.inline, highlight)}</span></div>`)

        return out
    })
}

function buildUnifiedHtml(leftLines: DiffLine[], rightLines: DiffLine[], highlight: (s: string) => string = escapeHtml, hunkMap?: Map<number, number>, hiddenRegions?: HiddenRegions): string {
    const out: string[] = []

    // Walk through the pair arrays interleaved
    // When left is removed and right empty → `-` line
    // When left empty and right is added → `+` line
    // When both unchanged → normal line with a space prefix
    for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
        const l = leftLines[i]
        const r = rightLines[i]
        const leftContent  = l ? renderInlineDiff(l.content, l.inline, highlight) : ''
        const rightContent = r ? renderInlineDiff(r.content, r.inline, highlight) : ''
        const lineNum = i + 1
        const rightLineNumber = l?.kind === 'removed' && r?.kind === 'added'
            ? '<span class="ln-num" aria-hidden="true"></span>'
            : `<span class="ln-num">${lineNum}</span>`
        const hiddenRegion = hiddenRegions?.starts.get(i)

        if (hiddenRegion) {
            out.push(renderHiddenRegion(hiddenRegion))
        }

        const hiddenRegionAtLine = hiddenRegions?.lineRegions.get(i)

        if (hiddenRegionAtLine) {
            if (l) {
                out.push(renderHiddenLine(l, lineNum, hiddenRegionAtLine, highlight))
            }

            continue
        }

        if (l && l.kind === 'removed') {
            const hunkIdx = hunkMap?.get(i)
            const title = hunkIdx === undefined ? '' : ADD_HUNK_TITLE
            const attrs = hunkIdx === undefined
                ? ''
                : ` data-hunk="${hunkIdx}" data-action="add" data-tooltip="${title}" aria-label="${title}" role="button" tabindex="0"`
            out.push(`<div class="line diff-removed${hunkIdx === undefined ? '' : ' clickable-hunk'}"${attrs}><span class="ln-num">${lineNum}</span><span class="ln">${leftContent}</span></div>`)
        }

        if (r && r.kind === 'added') {
            const hunkIdx = hunkMap?.get(i)
            const title = hunkIdx === undefined ? '' : REMOVE_HUNK_TITLE
            const attrs = hunkIdx === undefined
                ? ''
                : ` data-hunk="${hunkIdx}" data-action="remove" data-tooltip="${title}" aria-label="${title}" role="button" tabindex="0"`
            out.push(`<div class="line diff-added${hunkIdx === undefined ? '' : ' clickable-hunk'}"${attrs}>${rightLineNumber}<span class="ln">${rightContent}</span></div>`)
        }

        if (l && l.kind === 'unchanged') {
            out.push(`<div class="line"><span class="ln-num">${lineNum}</span><span class="ln">${leftContent}</span></div>`)
        }
    }

    return out.join('')
}

// ---------------------------------------------------------------------------
// Snapshot metadata helpers
// ---------------------------------------------------------------------------
const snapshotRegExp = /_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/

function parseSnapshotDate(filePath: string): Date | null {
    const {name} = path.parse(filePath)
    const match = name.match(snapshotRegExp)

    if (!match) {
        return null
    }

    return new Date(
        parseInt(match[1], 10),
        parseInt(match[2], 10) - 1,
        parseInt(match[3], 10),
        parseInt(match[4], 10),
        parseInt(match[5], 10),
        parseInt(match[6], 10),
    )
}

// ---------------------------------------------------------------------------
// TimelineProvider
// ---------------------------------------------------------------------------
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
    private _undoStacks             : Map<string, string[]> = new Map()
    private themeChangeSubscription : vscode.Disposable | undefined
    private lineHeightSubscription  : vscode.Disposable | undefined
    private navigationRenderTimer   : ReturnType<typeof setTimeout> | undefined
    private renderGeneration        : number = 0

    constructor(controller: HistoryController, extensionUri: vscode.Uri) {
        this.controller = controller
        this.extensionUri = extensionUri
        TimelineProvider.active = this
    }

    public static zoomIn = () => TimelineProvider.active?.sendZoom('in')
    public static zoomOut = () => TimelineProvider.active?.sendZoom('out')
    public static resetZoom = () => TimelineProvider.active?.sendZoom('reset')
    public static undo = () => TimelineProvider.active?.undoLastAction()

    private sendZoom(action: 'in' | 'out' | 'reset') {
        this.panel?.webview.postMessage({type: 'zoom', action})
    }

    private setActiveContext(active: boolean) {
        vscode.commands.executeCommand('setContext', 'localHistory:timelineActive', active)
    }

    /** Open timeline for the active editor or a specific file */
    async open(uri?: vscode.Uri) {
        let doc: vscode.TextDocument | undefined

        if (uri) {
            try {
                doc = await vscode.workspace.openTextDocument(uri)
            } catch {
                // fall through
            }
        }

        if (!doc) {
            const editor = vscode.window.activeTextEditor

            if (!editor) {
                vscode.window.showErrorMessage('No active editor to show timeline for.')

                return
            }

            doc = editor.document
        }

        const fileName = doc.fileName
        const settings = this.controller.getSettings(doc.uri)
        const fileProps = await this.controller.findAllHistory(fileName, settings, true)

        if (!fileProps.history || fileProps.history.length === 0) {
            vscode.window.showInformationMessage(`${PKG_CONFIG}: No history snapshots found for this file.`)

            return
        }

        // Reverse to newest-first (original is oldest-first)
        this.snapshots = [...fileProps.history].reverse()
        this.snapshotIndex = 0
        this.currentFileUri = doc.uri
        this.currentFileContent = doc.getText()
        this.currentLanguageId = doc.languageId

        this.showPanel()
        await this.renderSnapshot()
    }

    private showPanel() {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active)
            this.setActiveContext(true)
            // Refresh content in case current file changed
            this.reloadCurrentContent().then(() => this.renderSnapshot())

            return
        }

        this.panel = vscode.window.createWebviewPanel(
            'localHistoryTimeline',
            'Local History Timeline',
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
            this.setActiveContext(event.webviewPanel.active)
            event.webviewPanel.webview.postMessage({type: 'viewState', active: event.webviewPanel.active})
        }, null, this.disposables)
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
        this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables)

        // Refresh entire webview when theme changes — ensures fresh CSS
        // variables and re-initialises the SyntaxHighlighter from scratch.
        this.themeChangeSubscription = onDidChangeTheme(() => {
            vscode.window.showInformationMessage(`${PKG_CONFIG}: Please close & reopen the view for full syntax highlight support.`)

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
        const diff = computeLineDiff(snapshotContent, this.currentFileContent)
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
            if (leftLines[i].kind === 'removed' && rightLines[i].kind === 'added') {
                const [leftInline, rightInline] = computeInlineDiff(leftLines[i].content, rightLines[i].content)
                leftLines[i].inline = leftInline
                rightLines[i].inline = rightInline
            }
        }

        const highlightedLines = new Map<string, string>()

        const highlight = (line: string) => {
            let highlighted = highlightedLines.get(line)

            if (highlighted === undefined) {
                highlighted = hl(line)
                highlightedLines.set(line, highlighted)
            }

            return highlighted
        }

        const leftHtmlLines = buildSideHtml(leftLines, hiddenRegions, hunkMap, highlight, 'removed', 'added', 'diff-removed', 'add', ADD_HUNK_TITLE)
        const rightHtmlLines = buildSideHtml(rightLines, hiddenRegions, hunkMap, highlight, 'added', 'removed', 'diff-added', 'remove', REMOVE_HUNK_TITLE)

        // Build unified diff HTML (interleaved)
        const unifiedHtml = buildUnifiedHtml(leftLines, rightLines, highlight, hunkMap, hiddenRegions)

        const ext = path.extname(this.currentFileUri?.fsPath || '')

        this.panel.webview.postMessage({
            type       : 'render',
            leftHtml   : leftHtmlLines.join(''),
            rightHtml  : rightHtmlLines.join(''),
            unifiedHtml,
            fileName   : path.basename(this.currentFileUri?.fsPath || ''),
            extension  : ext,
            ...this.getNavigationState(),
            hasChanges : snapshotContent !== this.currentFileContent,
            hasUndo    : this.hasUndoContent(),
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
            case 'navigate':
                if (msg.direction === 'prev' && this.snapshotIndex < this.snapshots.length - 1) {
                    this.snapshotIndex++
                    this.renderGeneration++

                    if (msg.keyboard) {
                        this.scheduleNavigationRender()
                    } else {
                        await this.renderSnapshot()
                    }
                } else if (msg.direction === 'next' && this.snapshotIndex > 0) {
                    this.snapshotIndex--
                    this.renderGeneration++

                    if (msg.keyboard) {
                        this.scheduleNavigationRender()
                    } else {
                        await this.renderSnapshot()
                    }
                }

                break

            case 'restore':
                await this.restoreCurrentSnapshot()
                break

            case 'goto':
                this.cancelNavigationRender()
                this.renderGeneration++

                if (msg.index >= 0 && msg.index < this.snapshots.length && msg.index !== this.snapshotIndex) {
                    this.snapshotIndex = msg.index
                    await this.renderSnapshot()
                }

                break

            case 'ready':
                this.cancelNavigationRender()
                this.renderGeneration++
                await this.renderSnapshot()
                break

            case 'close':
                this.disposePanel()
                break

            case 'apply-hunk':
            case 'reject-hunk':
                await this.applyHunk(msg.index)
                break

            case 'undo':
                await this.undoLastAction()
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

    private async applyHunk(hunkIndex: number) {
        if (!this.currentFileUri || this.snapshots.length === 0) {
            return
        }

        const snapshotPath = this.snapshots[this.snapshotIndex]
        let snapshotContent: string

        try {
            snapshotContent = fs.readFileSync(snapshotPath, 'utf-8')
        } catch {
            return
        }

        const diff = computeLineDiff(snapshotContent, this.currentFileContent)
        const hunks = computeHunks(diff[0], diff[1])

        if (hunkIndex < 0 || hunkIndex >= hunks.length) {
            return
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

            return
        }

        // Reload current content and re-render
        const doc = await vscode.workspace.openTextDocument(this.currentFileUri)
        this.currentFileContent = doc.getText()
        await this.renderSnapshot()
    }

    private async undoLastAction() {
        if (!this.currentFileUri || !this.hasUndoContent()) {
            vscode.window.showInformationMessage(`${PKG_CONFIG}: Nothing to undo.`)

            return
        }

        let undoContent: string | null

        try {
            undoContent = this.readUndoContent()
        } catch {
            this.discardLastUndoContent()
            await this.renderSnapshot()

            return
        }

        if (undoContent === null) {
            this.discardLastUndoContent()
            await this.renderSnapshot()

            return
        }

        const edit = new vscode.WorkspaceEdit()
        const doc = await vscode.workspace.openTextDocument(this.currentFileUri)
        const fullRange = new vscode.Range(0, 0, doc.lineCount, 0)
        edit.replace(this.currentFileUri, fullRange, undoContent)
        const applied = await vscode.workspace.applyEdit(edit)

        if (!applied) {
            return
        }

        this.discardLastUndoContent()
        this.currentFileContent = (await vscode.workspace.openTextDocument(this.currentFileUri)).getText()
        await this.renderSnapshot()
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
            .replace(/__SCROLL_TOP_ICON_URI__/g, webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'images/icons/sort-up-filled.svg')).toString())
            .replace(/__CSP_SOURCE__/g, webview.cspSource)
            .replace(/__BREAKPOINT__/g, String(breakpoint))
            .replace(/__INITIAL_UNIFIED__/g, String(defaultView === 'unified'))
            .replace(/__LINE_HEIGHT__/g, lineHeight)
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
