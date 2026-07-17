import * as path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffLine {
    kind    : 'added' | 'removed' | 'unchanged'
    content : string
    inline? : InlineDiffPart[]
}

export interface InlineDiffPart {
    kind    : 'added' | 'removed' | 'unchanged'
    content : string
}

export type InlineDiff = [InlineDiffPart[], InlineDiffPart[]]

export interface HiddenRegion {
    start : number
    count : number
}

export interface HiddenRegions {
    starts      : Map<number, HiddenRegion>
    lineRegions : Map<number, HiddenRegion>
}

export interface Hunk {
    snapshotContent : string
    snapshotStart   : number
    snapshotEnd     : number
    currentContent  : string
    currentStart    : number
    currentEnd      : number
    alignedStart    : number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve))
}

// ---------------------------------------------------------------------------
// LCS backtracking
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Line-level diff
// ---------------------------------------------------------------------------

export async function computeLineDiff(
    leftText: string,
    rightText: string,
    shouldCancel?: () => boolean,
): Promise<DiffLine[][] | null> {
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
    const leftLength = middleLeftLines.length
    const rightLength = middleRightLines.length

    // Build LCS table
    const table: number[][] = Array.from({length: leftLength + 1}, () => new Array(rightLength + 1).fill(0))

    for (let i = 1; i <= leftLength; i++) {
        for (let j = 1; j <= rightLength; j++) {
            table[i][j] = middleLeftLines[i - 1] === middleRightLines[j - 1]
                ? table[i - 1][j - 1] + 1
                : Math.max(table[i - 1][j], table[i][j - 1])
        }

        if (shouldCancel && i % 128 === 0) {
            await yieldToEventLoop()

            if (shouldCancel()) {
                return null
            }
        }
    }

    const result: DiffLine[][] = [[], []]
    lcsBacktrack(table, middleLeftLines, middleRightLines, leftLength, rightLength, result)

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

// ---------------------------------------------------------------------------
// Inline (word-level) diff
// ---------------------------------------------------------------------------

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

function isWhitespaceOnly(s: string): boolean {
    return /^\s*$/.test(s)
}

function isWhitespaceOnlyDiff(inlineDiff: InlineDiff): boolean {
    const [left, right] = inlineDiff

    for (const part of left) {
        if (part.kind !== 'unchanged' && !isWhitespaceOnly(part.content)) {
            return false
        }
    }

    for (const part of right) {
        if (part.kind !== 'unchanged' && !isWhitespaceOnly(part.content)) {
            return false
        }
    }

    return true
}

export function computeInlineDiff(leftText: string, rightText: string): InlineDiff {
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

    // If all highlighted changes are whitespace-only, treat them as unchanged
    // so trivial indentation/trailing-space diffs don't get highlighted.
    if (isWhitespaceOnlyDiff(result)) {
        return [
            [{kind: 'unchanged', content: result[0].map((p) => p.content).join('')}],
            [{kind: 'unchanged', content: result[1].map((p) => p.content).join('')}],
        ]
    }

    return result
}

// ---------------------------------------------------------------------------
// Hidden regions (folding unchanged blocks)
// ---------------------------------------------------------------------------

export function computeHiddenRegions(lines: DiffLine[], enabled: boolean, minimumLineCount: number, contextLineCount: number): HiddenRegions {
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

export function computeHunks(leftLines: DiffLine[], rightLines: DiffLine[]): Hunk[] {
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

// ---------------------------------------------------------------------------
// Snapshot metadata helpers
// ---------------------------------------------------------------------------

const snapshotRegExp = /_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/

export function parseSnapshotDate(filePath: string): Date | null {
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
