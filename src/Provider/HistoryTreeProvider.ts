import * as vscode from 'vscode'
import * as utils from '../utils'
import {HistoryController, IHistoryFileProperties} from '../libs/Controller'
import {HistorySettings, IHistorySettings} from '../libs/Settings'

const enum EHistoryTreeItem {
    None = 0,
    Group,
    File,
}

const enum EHistoryTreeContentKind {
    Current = 0,
    All,
    Search,
}

export default class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryItem>  {
    private _onDidChangeTreeData : vscode.EventEmitter<HistoryItem | undefined> = new vscode.EventEmitter<HistoryItem | undefined>()
    readonly onDidChangeTreeData : vscode.Event<HistoryItem | undefined> = this._onDidChangeTreeData.event

    private currentHistoryFile : string
    private currentHistoryPath : string
    private historyFiles       : object // {yesterday: IHistoryFileProperties[]}
    // save historyItem structure to be able to redraw
    private tree = {}  // {yesterday: {grp: HistoryItem, items: HistoryItem[]}}
    private selection          : HistoryItem
    private activeFilePath     : string | undefined
    private treeView           : vscode.TreeView<HistoryItem> | undefined
    private noLimit = false
    private date   // relative date cutoffs computed from now()
    private format // date formatting function

    private pendingRevealPath : string | undefined
    private pendingRevealDate : Date | undefined

    public contentKind    : EHistoryTreeContentKind = 0
    private searchPattern : string
    private controller    : HistoryController

    constructor(controller: HistoryController) {
        this.controller = controller
        this.initLocation()
    }

    initLocation() {
        vscode.commands.executeCommand('setContext', 'localHistory:treeLocation', HistorySettings.getTreeLocation())
    }

    private setHasItems(hasItems: boolean) {
        vscode.commands.executeCommand('setContext', 'localHistory:hasItems', hasItems)
    }

    public isCurrentFile(file: vscode.Uri | undefined): boolean {
        return file?.fsPath === this.activeFilePath
    }

    public setTreeView(view: vscode.TreeView<HistoryItem>) {
        this.treeView = view
    }

    public getParent(element: HistoryItem): vscode.ProviderResult<HistoryItem> {
        if (element.kind === EHistoryTreeItem.File && element.grp) {
            return this.tree[element.grp]?.grp
        }

        return undefined
    }

    public findItemByPath(fsPath: string): HistoryItem | undefined {
        for (const groupName of Object.keys(this.tree)) {
            const group = this.tree[groupName]

            if (group.items) {
                for (const item of group.items) {
                    if (item.resourceUri && item.resourceUri.fsPath === fsPath) {
                        return item
                    }
                }
            }
        }

        return undefined
    }

    getSettingsItem(): HistoryItem {
        switch (this.contentKind) {
            case EHistoryTreeContentKind.All:
                return new HistoryItem(this, 'Search: all', EHistoryTreeItem.None, null, this.currentHistoryPath)
            case EHistoryTreeContentKind.Current:
                return new HistoryItem(this, 'Search: current', EHistoryTreeItem.None, null, this.currentHistoryFile)
            case EHistoryTreeContentKind.Search:
                return new HistoryItem(this, `Search: ${this.searchPattern}`, EHistoryTreeItem.None, null, this.searchPattern)
        }
    }

    getTreeItem(element: HistoryItem): vscode.TreeItem {
        return element
    }

    async getChildren(element?: HistoryItem): Promise<HistoryItem[]> {
        const hasTreeData = Object.keys(this.tree).length > 0

        // Root level: return settings item + groups
        if (!element) {
            if (hasTreeData) {
                return [this.getSettingsItem(), ...Object.keys(this.tree).map((key) => this.tree[key].grp)]
            }

            // First load: fetch history files and build groups
            if (!this.historyFiles) {
                const document = vscode.window.activeTextEditor?.document

                if (!document) {
                    return []
                }

                await this.loadHistoryFile(document.uri, this.controller.getSettings(document.uri))
            }

            const result = [this.getSettingsItem(), ...this.loadHistoryGroups(this.historyFiles)]
            this.tryRevealPending()

            return result
        }

        // Child level: return pre-loaded items for a group
        if (hasTreeData && this.tree[element.label]?.items) {
            this.tryRevealPending()

            return this.tree[element.label].items
        }

        // Lazy-load group items from historyFiles
        const items: HistoryItem[] = []

        if (element.kind === EHistoryTreeItem.Group && this.historyFiles?.[element.label]) {
            this.historyFiles[element.label].forEach((file) => {
                items.push(
                    new HistoryItem(
                        this,
                        this.format(file),
                        EHistoryTreeItem.File,
                        vscode.Uri.file(file.file),
                        element.label,
                        true,
                    ),
                )
            })
            this.tree[element.label].items = items
            this.tryRevealPending()
        }

        return items
    }

    private async loadHistoryFile(fileName: vscode.Uri, settings: IHistorySettings): Promise<object> {
        let pattern

        switch (this.contentKind) {
            case EHistoryTreeContentKind.All:
                pattern = '**/*.*'
                break
            case EHistoryTreeContentKind.Current:
                pattern = fileName.fsPath
                break
            case EHistoryTreeContentKind.Search:
                pattern = this.searchPattern
                break
        }

        const findFiles = await this.controller.findGlobalHistory(
            pattern,
            this.contentKind === EHistoryTreeContentKind.Current,
            settings,
            this.noLimit,
        )

        if (this.contentKind === EHistoryTreeContentKind.Current) {
            const historyFile = this.controller.decodeFile(fileName.fsPath, settings)
            this.currentHistoryFile = historyFile && historyFile.file
        }

        this.currentHistoryPath = settings.historyPath
        this.historyFiles = {}

        this.format = (file) => {
            const result = utils.formatDate(file.date, settings.dateLocale)

            if (this.contentKind !== EHistoryTreeContentKind.Current) {
                return `${file.name}${file.ext} (${result})`
            }

            return result
        }

        let group = 'new'
        const files = findFiles
            .map((file) => this.controller.decodeFile(file, settings))
            .sort((f1, f2) => {
                if (!f1 || !f2) {
                    return 0
                }

                if (f1.date > f2.date) {
                    return -1
                }

                if (f1.date < f2.date) {
                    return 1
                }

                return f1.name.localeCompare(f2.name)
            })

        files.forEach((file) => {
            if (!file) {
                return
            }

            if (group !== 'Older') {
                group = this.getRelativeDate(file.date)
            }

            this.historyFiles[group] = this.historyFiles[group] || []
            this.historyFiles[group].push(file)
        })

        return this.historyFiles
    }

    private loadHistoryGroups(historyFiles: object): HistoryItem[] {
        const historyGroupNames = Object.keys(historyFiles)

        this.setHasItems(historyGroupNames.length > 0)

        if (!historyGroupNames.length) {
            return [new HistoryItem(this, 'No history', EHistoryTreeItem.None)]
        }

        return historyGroupNames.map((groupName) => {
            const groupItem = new HistoryItem(this, groupName, EHistoryTreeItem.Group)
            this.tree[groupName] = {grp: groupItem}

            return groupItem
        })
    }

    private getRelativeDate(fileDate: Date) {
        const hour = 60 * 60
        const day = hour * 24
        const ref = fileDate.getTime() / 1000

        if (!this.date) {
            const dt = new Date()
            const now = dt.getTime() / 1000
            const today = dt.setHours(0, 0, 0, 0) / 1000 // clear current hour
            this.date = {
                now       : now,
                today     : today,
                week      : today - ((dt.getDay() || 7) - 1) * day, //  1st day of week (week start monday)
                month     : dt.setDate(1) / 1000,        // 1st day of current month
                lastMonth : dt.setDate(1) / 1000,     // 1st day of previous month
            }
        }

        if (this.date.now - ref < hour) {
            return 'In the last hour'
        } else if (ref > this.date.today) {
            return 'Today'
        } else if (ref > this.date.today - day) {
            return 'Yesterday'
        } else if (ref > this.date.week) {
            return 'This week'
        } else if (ref > this.date.week - (day * 7)) {
            return 'Last week'
        } else if (ref > this.date.month) {
            return 'This month'
        } else if (ref > this.date.lastMonth) {
            return 'Last month'
        } else {
            return 'Older'
        }
    }

    private redraw() {
        this._onDidChangeTreeData.fire(undefined)
    }

    private tryRevealPending() {
        if (!this.pendingRevealPath || !this.treeView) {
            return
        }

        const item = this.findItemByPath(this.pendingRevealPath)

        if (item) {
            this.treeView.reveal(item, {select: true, focus: false, expand: true})
            this.pendingRevealPath = undefined
            this.pendingRevealDate = undefined

            return
        }

        if (this.pendingRevealDate && this.historyFiles) {
            const groupName = this.getRelativeDate(this.pendingRevealDate)
            const groupItem = this.tree[groupName]?.grp

            if (groupItem) {
                this.treeView.reveal(groupItem, {select: false, focus: false, expand: true})

                return
            }
        }

        if (this.historyFiles) {
            this.pendingRevealPath = undefined
            this.pendingRevealDate = undefined
        }
    }

    public changeActiveFile(editor: vscode.TextEditor | undefined) {
        setTimeout(() => {
            if (!editor) {
                this.activeFilePath = undefined
                this.pendingRevealPath = undefined
                this.pendingRevealDate = undefined
                this.refresh()

                return
            }

            let filename = editor.document.uri
            const diff = editor.diffInformation

            if (diff?.length) {
                filename = diff[0].original
            }

            const settings = this.controller.getSettings(filename)
            const prop = this.controller.decodeFile(filename.fsPath, settings, false)

            const newActiveFile = (prop && prop.date) ? filename.fsPath : undefined
            const baseFileChanged = !prop || prop.file !== this.currentHistoryFile
            const activeFileChanged = this.activeFilePath !== newActiveFile

            this.currentHistoryFile = prop ? prop.file : undefined
            this.activeFilePath = newActiveFile

            if (baseFileChanged || activeFileChanged) {
                if (newActiveFile && prop) {
                    this.pendingRevealPath = newActiveFile
                    this.pendingRevealDate = prop.date
                } else {
                    this.pendingRevealPath = undefined
                    this.pendingRevealDate = undefined
                }

                this.refresh()
            }
        }, 50)
    }

    public refresh(noLimit = false): void {
        this.setHasItems(false)
        this.tree = {}
        this.noLimit = noLimit
        delete this.selection
        delete this.currentHistoryFile
        delete this.currentHistoryPath
        delete this.historyFiles
        delete this.date
        this._onDidChangeTreeData.fire(undefined)
    }

    public more(): void {
        if (!this.noLimit) {
            this.refresh(true)
        }
    }

    public deleteAll(): void {
        let message

        switch (this.contentKind) {
            case EHistoryTreeContentKind.All:
                message = `Delete all history - ${this.currentHistoryPath}?`
                break
            case EHistoryTreeContentKind.Current:
                message = `Delete history for ${this.currentHistoryFile} ?`
                break
            case EHistoryTreeContentKind.Search:
                message = `Delete history for ${this.searchPattern} ?`
                break
        }

        vscode.window.showInformationMessage(message, {modal: true}, {title: 'Yes'}, {title: 'No', isCloseAffordance: true})
            .then((sel) => {
                if (sel.title === 'Yes') {
                    switch (this.contentKind) {
                        case EHistoryTreeContentKind.All:
                            this.controller.deleteAll(this.currentHistoryPath)
                                .then(() => this.refresh())
                                .catch((err) => vscode.window.showErrorMessage(`Delete failed: ${err}`))
                            break
                        case EHistoryTreeContentKind.Current:
                            this.controller.deleteHistory(this.currentHistoryFile)
                                .then(() => this.refresh())
                                .catch((err) => vscode.window.showErrorMessage(`Delete failed: ${err}`))
                            break
                        case EHistoryTreeContentKind.Search:
                            const historyGroupNames = Object.keys(this.historyFiles)

                            if (historyGroupNames.length) {
                                const filesToDelete = historyGroupNames.flatMap((groupName) =>
                                    this.historyFiles[groupName].map((historyFile) => historyFile.file))

                                this.controller.deleteFiles(filesToDelete)
                                    .then(() => this.refresh())
                                    .catch((err) => vscode.window.showErrorMessage(`Delete failed: ${err}`))
                            }

                            break
                    }
                }
            },
            (err) => {
                return
            },
            )
    }

    public show(file: vscode.Uri): void {
        vscode.commands.executeCommand('vscode.open', file)
    }

    public showSide(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File) {
            vscode.commands.executeCommand('vscode.open', element.file, Math.min(vscode.window.activeTextEditor.viewColumn + 1, 3))
        }
    }

    public delete(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File) {
            this.controller.deleteFile(element.file.fsPath)
                .then(() => this.refresh())
        } else if (element.kind === EHistoryTreeItem.Group) {
            this.controller.deleteFiles(
                this.historyFiles[element.label].map((value: IHistoryFileProperties) => value.file))
                .then(() => this.refresh())
        }
    }

    public compareToCurrent(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File) {
            let currRange

            if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
              && vscode.window.activeTextEditor.document.fileName === this.currentHistoryFile) {
                const currPos = vscode.window.activeTextEditor.selection.active
                currRange = new vscode.Range(currPos, currPos)
            }

            this.controller.compare(element.file, vscode.Uri.file(this.currentHistoryFile), null, currRange)
        }
    }

    public select(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File) {
            if (this.selection) {
                delete this.selection.iconPath
            }

            this.selection = element
            this.tree[element.grp].grp.collapsibleState = vscode.TreeItemCollapsibleState.Expanded
            this.redraw()
        }
    }

    public compare(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File) {
            if (this.selection) {
                this.controller.compare(element.file, this.selection.file)
            } else {
                vscode.window.showErrorMessage('Select a history files to compare with')
            }
        }
    }

    public restore(element: HistoryItem): void {
        if (element.kind === EHistoryTreeItem.File) {
            this.controller.restore(element.file)
                .then(() => this.refresh())
                .catch((err) => vscode.window.showErrorMessage(`Restore ${element.file.fsPath} failed. Error: ${err}`))
        }
    }

    public forCurrentFile(): void {
        this.contentKind = EHistoryTreeContentKind.Current
        this.refresh()
    }

    public forAll(): void {
        this.contentKind = EHistoryTreeContentKind.All
        this.refresh()
    }

    public forSpecificFile(): void {
        vscode.window.showInputBox({prompt: 'Specify what to search:', value: '**/*myFile*.*', valueSelection: [4, 10]})
            .then((value) => {
                if (value) {
                    this.searchPattern = value
                    this.contentKind = EHistoryTreeContentKind.Search
                    this.refresh()
                }
            })
    }
}

class HistoryItem extends vscode.TreeItem {
    public readonly kind : EHistoryTreeItem
    public readonly file : vscode.Uri
    public readonly grp  : string

    constructor(
        provider: HistoryTreeProvider,
        label = '',
        kind: EHistoryTreeItem,
        file?: vscode.Uri,
        grp?: string,
        showIcon?: boolean,
    ) {
        utils.readConfig()
        const alwaysExpand = utils.config.alwaysExpand

        super(
            label,
            kind === EHistoryTreeItem.Group
                ? (alwaysExpand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
                : vscode.TreeItemCollapsibleState.None,
        )

        this.kind = kind
        this.file = file
        this.grp = this.kind !== EHistoryTreeItem.None ? grp : undefined

        switch (this.kind) {
            case EHistoryTreeItem.File:
                this.contextValue = 'localHistoryItem'
                this.tooltip = file.fsPath // TODO remove before .history
                this.resourceUri = file

                if (provider.isCurrentFile(file)) {
                    this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
                } else if (showIcon) {
                    this.iconPath = false
                }

                break
            case EHistoryTreeItem.Group:
                this.contextValue = 'localHistoryGrp'
                break
            default: // EHistoryTreeItem.None
                this.contextValue = 'localHistoryNone'
                this.tooltip = grp
        }

        let command: any = undefined

        // TODO: if current === file
        if (this.kind === EHistoryTreeItem.File) {
            if (provider.contentKind === EHistoryTreeContentKind.Current) {
                command = {
                    command   : 'treeLocalHistory.compareToCurrentEntry',
                    title     : 'Compare with current version',
                    arguments : [this],
                }
            } else {
                command = {
                    command   : 'treeLocalHistory.showEntry',
                    title     : 'Open Local History',
                    arguments : [file],
                }
            }
        }

        this.command = command
    }
}
