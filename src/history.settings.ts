import isPathInside from 'is-path-inside';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';

const enum EHistoryEnabled {
    Never = 0,
    Always,
    Workspace // only when file is in the opened folder
}

const enum EHistoryTreeLocation {
    Explorer = 0,
    LocalHistory
}

export interface IHistorySettings {
    folder: vscode.Uri;
    daysLimit: number;
    saveDelay: number;
    maxDisplay: number;
    dateLocale: string;
    exclude: string[];
    enabled: boolean;
    historyPath: string;
    absolute: boolean;
}

/**
 * Settings for history.
 */
export class HistorySettings {

    private settings: IHistorySettings[];

    public static getTreeLocation(): EHistoryTreeLocation {
        const config = vscode.workspace.getConfiguration('localHistory');

        return <EHistoryTreeLocation>config.get('treeLocation');
    }

    constructor() {
        this.settings = [];
    }

    public get(file: vscode.Uri): IHistorySettings {

        // Find workspaceFolder corresponding to file
        let folder;
        const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file.fsPath));

        if (wsFolder)
            folder = wsFolder.uri;

        let settings = this.settings.find((value, index, obj) => {
            if (folder && value.folder)
                return (value.folder.fsPath === folder.fsPath);
            else
                return (folder === value.folder);
        });

        if (!settings) {
            settings = this.read(folder, file, wsFolder);
            this.settings.push(settings);
        }

        return settings;
    }

    public clear() {
        this.settings = [];
    }

    /*
    historyPath
       absolute
         saved in historyPath\.history\<absolute>
       not absolute
         saved in historyPath\.history\vscode.getworkspacefolder.basename\<relative>
         (no workspacefolder like absolute if always)
    no historyPath
       saved in vscode.getworkspacefolder\.history\<relative>
       (no workspacefolder => not saved)
    */
    private read(workspacefolder: vscode.Uri, file: vscode.Uri, ws: vscode.WorkspaceFolder): IHistorySettings {
        let config = vscode.workspace.getConfiguration('localHistory'),
            enabled = <EHistoryEnabled>config.get('enabled'),
            exclude = <string[]>config.get('exclude'),
            historyPath,
            absolute,
            message = '';

        if (typeof enabled === 'boolean')
            message += 'localHistory.enabled must be a number, ';
        if (typeof exclude === 'string')
            message += 'localHistory.exclude must be an array, ';
        if (message)
            vscode.window.showWarningMessage(`Change setting: ${message.slice(0, -2)}`, {}, { title: 'Settings', isCloseAffordance: false, id: 0 })
                .then((action) => {
                    if (action && action.id === 0)
                        vscode.commands.executeCommand('workbench.action.openGlobalSettings');
                });

        if (enabled !== EHistoryEnabled.Never) {
            historyPath = <string>config.get('path');
            if (historyPath) {

                historyPath = historyPath
                    // replace variables like %AppData%
                    .replace(/%([^%]+)%/g, (_, key) => process.env[key])
                    // supports character ~ for homedir
                    .replace(/^~/, os.homedir());

                // start with
                // ${workspaceFolder} => current workspace
                // ${workspaceFolder: name} => workspace find by name
                // ${workspaceFolder: index} => workspace find by index
                const match = historyPath.match(/\${workspaceFolder(?:\s*:\s*(.*))?}/i);
                let historyWS: vscode.Uri;

                if (match) {
                    if (match.index > 1) {
                        vscode.window.showErrorMessage(`\${workspaceFolder} must starts settings localHistory.path ${historyPath}`);
                    } else {
                        const wsId = match[1];

                        if (wsId) {
                            const find = vscode.workspace.workspaceFolders.find(
                                (wsf) => (Number.isInteger(wsId - 1) ? wsf.index === Number.parseInt(wsId, 10) : wsf.name === wsId));

                            if (find)
                                historyWS = find.uri;
                            else
                                vscode.window.showErrorMessage(`workspaceFolder not found ${historyPath}`);
                        } else
                            historyWS = workspacefolder;
                    }

                    if (historyWS)
                        historyPath = historyPath.replace(match[0], historyWS.fsPath);
                    else
                        historyPath = null;
                }

                if (historyPath) {
                    absolute = <boolean>config.get('absolute');
                    if (absolute || (!workspacefolder && enabled === EHistoryEnabled.Always)) {
                        absolute = true;
                        historyPath = path.join(
                            historyPath,
                            '.history');
                    } else if (workspacefolder) {
                        historyPath = path.join(
                            historyPath,
                            '.history',
                            (historyWS && this.pathIsInside(workspacefolder.fsPath, historyWS.fsPath) ? '' : path.basename(workspacefolder.fsPath)),
                        );
                    }
                }

            } else if (workspacefolder) {
                // Save only files in workspace
                absolute = false;
                historyPath = path.join(
                    workspacefolder.fsPath,
                    '.history',
                );
            }
        }

        if (historyPath)
            historyPath = historyPath.replace(/\//g, path.sep);

        return {
            folder     : workspacefolder,
            daysLimit  : <number>config.get('daysLimit', 30),
            saveDelay  : <number>config.get('saveDelay', 0),
            maxDisplay : <number>config.get('maxDisplay', 10),
            dateLocale : <string>config.get('dateLocale'),
            exclude    : <string[]>config.get('exclude', [
                '**/.history/**',
                '**/.vscode/**',
                '**/node_modules/**',
                '**/typings/**',
                '**/out/**',
            ]),
            enabled     : historyPath != null && historyPath !== '',
            historyPath : historyPath,
            absolute    : absolute,
        };
    }

    private pathIsInside(test, parent) {
        return isPathInside(test, parent);
    }
}
