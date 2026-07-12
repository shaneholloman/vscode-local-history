# CHANGELOG

## 0.0.1

- update pkgs
- merge PRs
- update configs
- add new config `local-history.alwaysExpand`

## 0.0.2

- change config key `local-history` to `localHistory`

## 0.0.3

- cleanups
- add new config `localHistory.suppressErrors`
- update vscode minimum version to `1.68`
- make sure to hide the tree items when no editor is opened

## 0.0.4

- fix: Handle special characters in file path @wrgrant

## 0.0.5

- update rdme, thanx @shaneholloman

## 0.1.0

- upgrade vscode to v110 + deps
- fix absolute path normalization @Cinabutts
- add visual diff webview for history navigator (side-by-side & unified)
    - use existing vscode configs ex`"line hight, diff editor, etc.."
    - use active theme colors
    - hunk add/remove support + undo stack
    - zoom control
    - right/left navigate history
    - up/down scroll vertically
    - direct jump & restore snapshot from the view
    - line & word diff render
