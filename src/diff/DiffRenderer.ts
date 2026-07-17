import {DiffLine, HiddenRegion, HiddenRegions, InlineDiffPart} from './DiffEngine'
import {escapeHtml} from '../utils'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ADD_HUNK_TITLE    = 'Add this change'
export const REMOVE_HUNK_TITLE = 'Remove this change'

// ---------------------------------------------------------------------------
// Rendering primitives
// ---------------------------------------------------------------------------

export function renderHiddenRegion(region: HiddenRegion): string {
    const title = `Show ${region.count} unchanged lines`

    return `<div class="line unchanged-region clickable-region" data-region="${region.start}" data-line="${region.start + 1}" data-count="${region.count}" data-tooltip="${title}" aria-label="${title}" role="button" tabindex="0"><span class="hidden-label" data-region-label="${region.start}">${title}</span></div>`
}

export function renderHiddenLine(diffLine: DiffLine, lineNumber: number, highlight: (s: string) => string): string {
    return `<div class="line" data-line="${lineNumber}"><span class="ln-num">${lineNumber}</span><span class="ln">${highlight(diffLine.content)}</span></div>`
}

export function renderInlineDiff(content: string, parts: InlineDiffPart[] | undefined, highlight: (s: string) => string): string {
    if (!parts) {
        return highlight(content)
    }

    return parts.map((part) => part.kind === 'unchanged' || /^\s+$/u.test(part.content)
        ? highlight(part.content)
        : `<span class="inline-diff-${part.kind}">${highlight(part.content)}</span>`).join('')
}

// ---------------------------------------------------------------------------
// Side-by-side HTML builder
// ---------------------------------------------------------------------------

export interface SideHtmlConfig {
    lines         : DiffLine[]
    hiddenRegions : HiddenRegions
    hunkMap       : Map<number, number>
    highlight     : (s: string) => string
    changedKind   : 'added' | 'removed'
    emptyKind     : 'added' | 'removed'
    changedClass  : string
    action        : 'add' | 'remove'
    title         : string
}

export function buildSideHtml(config: SideHtmlConfig): string[] {
    const {lines, hiddenRegions, hunkMap, highlight, changedKind, emptyKind, changedClass, action, title} = config
    const out: string[] = []

    for (let i = 0; i < lines.length; i++) {
        const diffLine = lines[i]
        const hiddenRegion = hiddenRegions.starts.get(i)
        const hiddenRegionAtLine = hiddenRegions.lineRegions.get(i)

        if (hiddenRegion) {
            out.push(renderHiddenRegion(hiddenRegion))
            out.push(`<div class="region-block" data-region="${hiddenRegion.start}"><div class="region-inner">`)
        }

        if (hiddenRegionAtLine) {
            out.push(renderHiddenLine(diffLine, i + 1, highlight))

            if (!hiddenRegions.lineRegions.has(i + 1)) {
                out.push('</div></div>')
            }

            continue
        }

        const cssClass = diffLine.kind === changedKind
            ? ` ${changedClass}`
            : diffLine.kind === emptyKind ? ' diff-empty' : ''
        const hunkIdx = hunkMap.get(i)
        const hunkTitle = hunkIdx === undefined ? '' : title
        const attrs = hunkIdx === undefined
            ? ''
            : ` data-line="${i + 1}" data-hunk="${hunkIdx}" data-i="${i}" data-action="${action}" data-tooltip="${hunkTitle}" aria-label="${hunkTitle}" role="button" tabindex="0"`

        const lineAttrs = hunkIdx === undefined ? ` data-line="${i + 1}"` : attrs
        out.push(`<div class="line${cssClass}${hunkIdx === undefined ? '' : ' clickable-hunk'}"${lineAttrs}><span class="ln-num">${i + 1}</span><span class="ln">${renderInlineDiff(diffLine.content, diffLine.inline, highlight)}</span></div>`)
    }

    return out
}

// ---------------------------------------------------------------------------
// Unified HTML builder
// ---------------------------------------------------------------------------

export function buildUnifiedHtml(leftLines: DiffLine[], rightLines: DiffLine[], highlight: (s: string) => string = escapeHtml, hunkMap?: Map<number, number>, hiddenRegions?: HiddenRegions): string {
    const out: string[] = []

    for (let i = 0; i < Math.max(leftLines.length, rightLines.length); i++) {
        const leftLine = leftLines[i]
        const rightLine = rightLines[i]
        const leftContent  = leftLine ? renderInlineDiff(leftLine.content, leftLine.inline, highlight) : ''
        const rightContent = rightLine ? renderInlineDiff(rightLine.content, rightLine.inline, highlight) : ''
        const lineNum = i + 1
        const rightLineNumber = leftLine?.kind === 'removed' && rightLine?.kind === 'added'
            ? '<span class="ln-num" aria-hidden="true"></span>'
            : `<span class="ln-num">${lineNum}</span>`
        const hiddenRegion = hiddenRegions?.starts.get(i)

        if (hiddenRegion) {
            out.push(renderHiddenRegion(hiddenRegion))
            out.push(`<div class="region-block" data-region="${hiddenRegion.start}"><div class="region-inner">`)
        }

        const hiddenRegionAtLine = hiddenRegions?.lineRegions.get(i)

        if (hiddenRegionAtLine) {
            if (leftLine) {
                out.push(renderHiddenLine(leftLine, lineNum, highlight))
            }

            if (!hiddenRegions?.lineRegions.has(i + 1)) {
                out.push('</div></div>')
            }

            continue
        }

        if (leftLine && leftLine.kind === 'removed') {
            const hunkIdx = hunkMap?.get(i)
            const hunkTitle = hunkIdx === undefined ? '' : ADD_HUNK_TITLE
            const attrs = hunkIdx === undefined
                ? ''
                : ` data-line="${lineNum}" data-hunk="${hunkIdx}" data-i="${i}" data-action="add" data-tooltip="${hunkTitle}" aria-label="${hunkTitle}" role="button" tabindex="0"`
            const lineAttrs = hunkIdx === undefined ? ` data-line="${lineNum}"` : attrs
            out.push(`<div class="line diff-removed${hunkIdx === undefined ? '' : ' clickable-hunk'}"${lineAttrs}><span class="ln-num">${lineNum}</span><span class="ln">${leftContent}</span></div>`)
        }

        if (rightLine && rightLine.kind === 'added') {
            const hunkIdx = hunkMap?.get(i)
            const hunkTitle = hunkIdx === undefined ? '' : REMOVE_HUNK_TITLE
            const attrs = hunkIdx === undefined
                ? ''
                : ` data-line="${lineNum}" data-hunk="${hunkIdx}" data-i="${i}" data-action="remove" data-tooltip="${hunkTitle}" aria-label="${hunkTitle}" role="button" tabindex="0"`
            const lineAttrs = hunkIdx === undefined ? ` data-line="${lineNum}"` : attrs
            out.push(`<div class="line diff-added${hunkIdx === undefined ? '' : ' clickable-hunk'}"${lineAttrs}>${rightLineNumber}<span class="ln">${rightContent}</span></div>`)
        }

        if (leftLine && leftLine.kind === 'unchanged') {
            out.push(`<div class="line" data-line="${lineNum}"><span class="ln-num">${lineNum}</span><span class="ln">${leftContent}</span></div>`)
        }
    }

    return out.join('')
}
