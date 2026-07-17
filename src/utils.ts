import * as vscode from 'vscode'

export const PKG_CONFIG = 'localHistory'
export const CMND_NAME = 'local-history'

export let config: vscode.WorkspaceConfiguration

export function readConfig() {
    config = vscode.workspace.getConfiguration(PKG_CONFIG)
}

export function formatDate(date: Date, locale = config.dateLocale): string {
    if (config.get<string>('dateFormat', 'timestamp') === 'human') {
        return date.toLocaleString(undefined, {
            weekday : 'short',
            year    : 'numeric',
            month   : 'short',
            day     : 'numeric',
            hour    : '2-digit',
            minute  : '2-digit',
            hour12  : true,
        })
    }

    return date.toLocaleString(locale)
}

export function getIconPath(webview: vscode.Webview, extensionUri: vscode.Uri, iconName: string): string {
    return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'images', 'icons', iconName)).toString()
}

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}
