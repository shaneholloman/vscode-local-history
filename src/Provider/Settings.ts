import isPathInside from 'is-path-inside';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import * as utils from '../utils';

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
        return <EHistoryTreeLocation>utils.config.treeLocation;
    }

    constructor() {
        utils.readConfig();

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
        const config = utils.readConfig();
        const enabled = <EHistoryEnabled>utils.config.enabled;
        let historyPath;
        let absolute;

        if (enabled !== EHistoryEnabled.Never) {
            historyPath = <string>utils.config.path;

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
                    absolute = <boolean>utils.config.absolute;

                    if (absolute || (!workspacefolder && enabled === EHistoryEnabled.Always)) {
                        absolute = true;
                        historyPath = path.join(historyPath, '.history');
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
                historyPath = path.join(workspacefolder.fsPath, '.history');
            }
        }

        if (historyPath)
            historyPath = historyPath.replace(/\//g, path.sep);

        return {
            folder      : workspacefolder,
            daysLimit   : utils.config.daysLimit,
            saveDelay   : utils.config.saveDelay,
            maxDisplay  : utils.config.maxDisplay,
            dateLocale  : utils.config.dateLocale,
            exclude     : utils.config.exclude,
            enabled     : historyPath != null && historyPath !== '',
            historyPath : historyPath,
            absolute    : absolute,
        };
    }

    private pathIsInside(test, parent) {
        return isPathInside(test, parent);
    }
}
