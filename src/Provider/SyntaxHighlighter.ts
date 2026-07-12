import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import {Registry, INITIAL} from 'vscode-textmate'
import {loadWASM, createOnigScanner, createOnigString} from 'vscode-oniguruma'

// ---------------------------------------------------------------------------
// Shorthand → scope mapping for editor.tokenColorCustomizations
// ---------------------------------------------------------------------------
const SHORTHAND_SCOPES: Record<string, string[]> = {
    comments  : ['comment', 'comment.line', 'comment.block', 'punctuation.definition.comment'],
    strings   : ['string', 'string.quoted', 'string.template'],
    keywords  : ['keyword', 'keyword.control', 'storage', 'storage.type', 'storage.modifier'],
    types     : ['entity.name.type', 'entity.name.type.class', 'entity.name.type.interface', 'support.class', 'storage.type'],
    numbers   : ['constant.numeric', 'constant.numeric.integer', 'constant.numeric.float'],
    functions : ['entity.name.function', 'support.function', 'entity.name.function.method'],
    variables : ['variable', 'variable.other', 'variable.other.readwrite', 'variable.language'],
}

// Default Dark+ token colors (scope-keyword → hex) — used as fallback
const DARK_COLORS: [string, string][] = [
    ['comment', '#6a9955'],
    ['keyword', '#569cd6'],
    ['storage', '#569cd6'],
    ['string', '#ce9178'],
    ['constant.numeric', '#b5cea8'],
    ['constant.language', '#569cd6'],
    ['constant', '#4fc1ff'],
    ['entity.name.function', '#dcdcaa'],
    ['entity.name.type', '#4ec9b0'],
    ['entity.other.attribute-name', '#9cdcfe'],
    ['variable.language', '#569cd6'],
    ['support.function', '#dcdcaa'],
    ['support.class', '#4ec9b0'],
    ['decorator', '#c586c0'],
    ['markup.underline.link', '#569cd6'],
]

// Default Light+ token colors
const LIGHT_COLORS: [string, string][] = [
    ['comment', '#008000'],
    ['keyword', '#0000ff'],
    ['storage', '#0000ff'],
    ['string', '#a31515'],
    ['constant.numeric', '#098658'],
    ['constant.language', '#0000ff'],
    ['constant', '#0451a5'],
    ['entity.name.function', '#795e26'],
    ['entity.name.type', '#267f99'],
    ['entity.other.attribute-name', '#e50000'],
    ['variable.language', '#0000ff'],
    ['support.function', '#795e26'],
    ['support.class', '#267f99'],
    ['decorator', '#c586c0'],
    ['markup.underline.link', '#0000ff'],
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface GrammarDefinition {
    language      : string | undefined
    scopeName     : string
    path          : string
    extensionPath : string
}

const LANGUAGE_ALIASES: Record<string, string> = {
    yml : 'yaml',
}

function getGrammarDefinitions(): GrammarDefinition[] {
    const definitions: GrammarDefinition[] = []

    for (const extension of vscode.extensions.all) {
        const grammars = extension.packageJSON?.contributes?.grammars

        if (!Array.isArray(grammars)) {
            continue
        }

        for (const grammar of grammars) {
            if (typeof grammar.scopeName !== 'string' || typeof grammar.path !== 'string') {
                continue
            }

            definitions.push({
                language      : typeof grammar.language === 'string' ? grammar.language : undefined,
                scopeName     : grammar.scopeName,
                path          : grammar.path,
                extensionPath : extension.extensionPath,
            })
        }
    }

    return definitions
}

function findGrammarForLanguage(languageId: string): GrammarDefinition | undefined {
    const id = LANGUAGE_ALIASES[languageId] ?? languageId

    return getGrammarDefinitions().find((grammar) => grammar.language === id)
}

function loadGrammarFile(scopeName: string): any | null {
    const grammar = getGrammarDefinitions().find((entry) => entry.scopeName === scopeName)

    if (!grammar) {
        return null
    }

    try {
        return JSON.parse(fs.readFileSync(path.join(grammar.extensionPath, grammar.path), 'utf-8'))
    } catch {
        return null
    }
}

interface ThemeRule {
    scopes     : string[]
    foreground : string
}

const themeCache = new Map<string, ThemeRule[]>()

/** Best-match a scope string against an array of theme rules. */
function matchRules(rules: ThemeRule[] | undefined, scopes: string[]): string | null {
    if (!rules) {
        return null
    }

    let best: {color: string, len: number} | null = null

    for (const rule of rules) {
        for (const ruleScope of rule.scopes) {
            const rs = ruleScope.toLowerCase()

            for (const tokenScope of scopes) {
                if (tokenScope.toLowerCase().includes(rs)) {
                    if (!best || rs.length > best.len) {
                        best = {color: rule.foreground, len: rs.length}
                    }
                }
            }
        }
    }

    return best?.color ?? null
}

function pickColor(scopes: string[], isDark: boolean): string | null {
    // Try active theme rules first
    const fromActive = matchRules(themeCache.get('_active'), scopes)

    if (fromActive) {
        return fromActive
    }

    // Try previous theme (before last config change) — better than hardcoded
    const fromFallback = matchRules(themeCache.get('_fallback'), scopes)

    if (fromFallback) {
        return fromFallback
    }

    // Hardcoded defaults as last resort
    const table = isDark ? DARK_COLORS : LIGHT_COLORS

    for (const [key, color] of table) {
        for (const scope of scopes) {
            if (scope.toLowerCase().includes(key)) {
                return color
            }
        }
    }

    return null
}

// ---------------------------------------------------------------------------
// Config change watcher — invalidates theme cache on relevant changes
// ---------------------------------------------------------------------------

const _onDidChangeTheme = new vscode.EventEmitter<void>()

/** Fires when the active color theme or token color customizations change. */
export const onDidChangeTheme = _onDidChangeTheme.event

let _watcherDisposable: vscode.Disposable | null = null

function ensureWatcher(): void {
    if (_watcherDisposable) {
        return
    }

    _watcherDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
        if (
            e.affectsConfiguration('workbench.colorTheme')
            || e.affectsConfiguration('editor.tokenColorCustomizations')
            || e.affectsConfiguration('editor.semanticTokenColorCustomizations')
        ) {
            // Preserve previous theme as fallback so pickColor doesn't drop
            // straight to hardcoded defaults if re-parse of the new theme fails.
            const active = themeCache.get('_active')

            if (active) {
                themeCache.set('_fallback', active)
            }

            themeCache.delete('_active')
            _onDidChangeTheme.fire()
        }
    })
}

/** Cleanup watcher and emitter (call on extension deactivate). */
export function disposeHighlighter(): void {
    _watcherDisposable?.dispose()
    _watcherDisposable = null
    _onDidChangeTheme.dispose()
}

// ---------------------------------------------------------------------------
// Active theme reader – resolves scope → color from the current VS Code theme
// ---------------------------------------------------------------------------

function loadActiveTheme(): ThemeRule[] | null {
    const themeId = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme')

    if (!themeId) {
        return null
    }

    // Get raw theme rules from cache or parse the theme file
    let rawRules: ThemeRule[] | undefined
    const cached = themeCache.get(themeId)

    if (cached) {
        rawRules = cached
    } else {
        try {
            const parsed = findAndParseTheme(themeId)

            if (parsed) {
                themeCache.set(themeId, parsed)
                rawRules = parsed
            }
        } catch {
            // fall through
        }
    }

    if (!rawRules) {
        return null
    }

    // Build active: shallow-clone raw + always-fresh customizations.
    // Cloning ensures we never mutate the cache, so subsequent calls
    // when customizations change produce correct results.
    const active: ThemeRule[] = rawRules.map((r) => ({...r, scopes: [...r.scopes]}))
    themeCache.set('_active', active)

    // Incorporate user tokenColorCustomizations
    const customizations = vscode.workspace.getConfiguration('editor').get<any>('tokenColorCustomizations')

    if (customizations) {
        // textMateRules
        if (Array.isArray(customizations.textMateRules)) {
            for (const entry of customizations.textMateRules) {
                if (!entry.settings?.foreground) {
                    continue
                }

                const scopes = typeof entry.scope === 'string'
                    ? [entry.scope]
                    : Array.isArray(entry.scope) ? entry.scope : []

                if (scopes.length > 0) {
                    active.push({scopes, foreground: entry.settings.foreground})
                }
            }
        }

        // Shorthand overrides (comments/strings/keywords/types/numbers/functions/variables)
        for (const [shorthand, scopes] of Object.entries(SHORTHAND_SCOPES)) {
            const color = customizations[shorthand]

            if (typeof color === 'string') {
                active.unshift({scopes, foreground: color})
            }
        }
    }

    // editor.semanticTokenColorCustomizations
    const semantic = vscode.workspace.getConfiguration('editor').get<any>('semanticTokenColorCustomizations')

    if (semantic && semantic.enabled !== false) {
        const rulesMap = semantic.rules

        if (rulesMap && typeof rulesMap === 'object') {
            for (const [scope, value] of Object.entries(rulesMap)) {
                if (typeof value === 'string') {
                    active.push({scopes: [scope], foreground: value})
                } else if (typeof value === 'object' && value !== null && typeof (value as any).foreground === 'string') {
                    active.push({scopes: [scope], foreground: (value as any).foreground})
                }
            }
        }
    }

    return active
}

function findAndParseTheme(themeId: string): ThemeRule[] | null {
    for (const ext of vscode.extensions.all) {
        const themes: any[] = ext.packageJSON?.contributes?.themes

        if (!themes) {
            continue
        }

        for (const t of themes) {
            const label = t.label ?? ''
            const id = t.id ?? ''

            if (
                label === themeId || id === themeId
                || label.toLowerCase() === themeId.toLowerCase()
                || id.toLowerCase() === themeId.toLowerCase()
            ) {
                if (!t.path) {
                    continue
                }

                const themePath = path.join(ext.extensionPath, t.path)

                if (!fs.existsSync(themePath)) {
                    continue
                }

                return parseThemeFile(themePath)
            }
        }
    }

    return null
}

function parseThemeFile(filePath: string): ThemeRule[] {
    const rules: ThemeRule[] = []
    let raw: any

    try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    } catch {
        return rules
    }

    // Resolve includes first (base theme rules come before overrides)
    if (raw.include) {
        const basePath = path.resolve(path.dirname(filePath), raw.include)

        if (fs.existsSync(basePath)) {
            rules.push(...parseThemeFile(basePath))
        }
    }

    // Parse tokenColors
    if (Array.isArray(raw.tokenColors)) {
        for (const entry of raw.tokenColors) {
            if (!entry.settings?.foreground) {
                continue
            }

            let scopes: string[]

            if (typeof entry.scope === 'string') {
                scopes = [entry.scope]
            } else if (Array.isArray(entry.scope)) {
                scopes = entry.scope
            } else {
                continue
            }

            if (scopes.length > 0) {
                rules.push({scopes, foreground: entry.settings.foreground})
            }
        }
    }

    return rules
}

// ---------------------------------------------------------------------------
// TextMate engine state
// ---------------------------------------------------------------------------
let registry: Registry | null = null
let initPromise: Promise<void> | null = null
const grammarCache = new Map<string, any>()

async function ensureInit(): Promise<void> {
    if (initPromise) {
        return initPromise
    }

    initPromise = (async() => {
        try {
            let wasmPath: string | undefined

            try {
                wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm')
            } catch {
                const probe = path.join(__dirname, '..', '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')

                if (fs.existsSync(probe)) {
                    wasmPath = probe
                }
            }

            if (!wasmPath) {
                return
            }

            const wasmBin = fs.readFileSync(wasmPath).buffer
            await loadWASM(wasmBin)

            registry = new Registry({
                onigLib : Promise.resolve({
                    createOnigScanner : (sources: string[]) => createOnigScanner(sources),
                    createOnigString  : (str: string) => createOnigString(str),
                }),
                loadGrammar : async(scopeName: string) => loadGrammarFile(scopeName),
            })
        } catch {
            // Fail silently — highlighting degrades to plain text
        }
    })()

    return initPromise
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a synchronous `(line: string) => string` function that produces
 * syntax-highlighted HTML (with inline color styles) for the given language.
 *
 * Falls back to `escapeHtml` when the language is unknown, WASM/grammars
 * could not be loaded, or init hasn't completed yet.
 */
export async function getHighlighter(languageId: string): Promise<(line: string) => string> {
    await ensureInit()

    // Set up config watcher on first call
    ensureWatcher()

    const definition = findGrammarForLanguage(languageId)
    const scope = definition?.scopeName

    if (!scope || !registry) {
        return escapeHtml
    }

    // Load (or retrieve cached) grammar
    let grammar: any = grammarCache.get(scope)

    if (!grammar) {
        try {
            grammar = await registry.loadGrammar(scope)

            if (grammar) {
                grammarCache.set(scope, grammar)
            }
        } catch {
            return escapeHtml
        }
    }

    if (!grammar) {
        return escapeHtml
    }

    // Load active theme token colors (cached, sync)
    loadActiveTheme()

    // Determine dark/light once
    const isDark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light

    return (line: string): string => {
        const result = grammar.tokenizeLine(line)
        const out: string[] = []
        let pos = 0

        for (const token of result.tokens) {
            if (token.startIndex > pos) {
                out.push(escapeHtml(line.slice(pos, token.startIndex)))
            }

            const text = line.slice(token.startIndex, token.endIndex)
            const color = pickColor(token.scopes, isDark)

            if (color) {
                out.push(`<span style="color:${color}">${escapeHtml(text)}</span>`)
            } else {
                out.push(escapeHtml(text))
            }

            pos = token.endIndex
        }

        if (pos < line.length) {
            out.push(escapeHtml(line.slice(pos)))
        }

        return out.join('')
    }
}
