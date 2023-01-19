import * as vscode from 'vscode';

export const PKG_CONFIG = 'localHistory';
export const CMND_NAME = 'local-history';

export let config: vscode.WorkspaceConfiguration;

export function readConfig() {
    config = vscode.workspace.getConfiguration(PKG_CONFIG);
}
