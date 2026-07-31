import * as path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiffLine {
    kind           : 'added' | 'removed' | 'unchanged' | 'moved'
    content        : string
    inline?        : InlineDiffPart[]
    moveId?        : number
    moveConnector? : number
}

export interface InlineDiffPart {
    kind    : 'added' | 'removed' | 'unchanged'
    content : string
}

export type InlineDiff = [InlineDiffPart[], InlineDiffPart[]]

export interface HiddenRegion {
    start            : number
    count            : number
    connectorMoveId? : number
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

function findConnectorMoveId(lines: DiffLine[], start: number, count: number): number | undefined {
    const end = start + count

    for (let i = start; i < end; i++) {
        if (lines[i].moveConnector !== undefined) {
            return lines[i].moveConnector
        }
    }

    return undefined
}

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
                const connectorMoveId = findConnectorMoveId(lines, runStart, runLength)
                const region: HiddenRegion = {start: runStart, count: runLength, connectorMoveId}
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
            const connectorMoveId = findConnectorMoveId(lines, start, count)
            const region: HiddenRegion = {start, count, connectorMoveId}

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
// Moved block detection (git's --color-moved algorithm)
// ---------------------------------------------------------------------------
// Replaces the previous Jaccard similarity approach with git's exact-match
// block detection, matching `git diff --color-moved` (zebra mode):
//   1. Extract del-blocks (removed) and add-blocks (added) as maximal
//      consecutive runs of same-sign lines.
//   2. Greedy block scan: match consecutive del lines against consecutive
//      add lines by exact content equality. Each add-block line can only
//      be claimed by one match (one-to-one). When a match fails the size
//      filter, rewind to retry from the next del line (allows shorter
//      valid blocks starting later inside a failed longer block).
//   3. Size filter: require >= 20 alphanumeric characters across the
//      matched block's lines (COLOR_MOVED_MIN_ALNUM_COUNT, diff.c:1193).
//   4. Zebra striping: each matched block gets a unique moveId so adjacent
//      blocks receive different colors via the renderer's moveId % 5 cycling.
// Reference: git source at SHA a97fcc37c2bc6340a8d7ce78dedf227aac4e9aa7
// ---------------------------------------------------------------------------

const COLOR_MOVED_MIN_ALNUM_COUNT = 20

function countAlnum(str: string): number {
    let count = 0

    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i)

        if (
            (c >= 48 && c <= 57)
            || (c >= 65 && c <= 90)
            || (c >= 97 && c <= 122)
        ) {
            count++
        }
    }

    return count
}

export function detectMovedBlocks(
    leftLines: DiffLine[],
    rightLines: DiffLine[],
): void {
    // --- Phase 1: Extract del-blocks and add-blocks ---
    // A del-block is a maximal run of 'removed' lines (content from leftLines).
    // An add-block is a maximal run of 'added' lines (content from rightLines).
    // A moved block can never span a context line or sign change.

    interface Block {
        startPos : number
        endPos   : number
        lines    : string[]
    }

    const delBlocks: Block[] = []
    const addBlocks: Block[] = []

    for (let i = 0; i < leftLines.length; i++) {
        if (leftLines[i].kind === 'removed') {
            const start = i
            const lines: string[] = []

            while (i < leftLines.length && leftLines[i].kind === 'removed') {
                lines.push(leftLines[i].content)
                i++
            }

            delBlocks.push({startPos: start, endPos: i, lines})
        }
    }

    for (let i = 0; i < rightLines.length; i++) {
        if (rightLines[i].kind === 'added') {
            const start = i
            const lines: string[] = []

            while (i < rightLines.length && rightLines[i].kind === 'added') {
                lines.push(rightLines[i].content)
                i++
            }

            addBlocks.push({startPos: start, endPos: i, lines})
        }
    }

    if (delBlocks.length === 0 || addBlocks.length === 0) {
        return
    }

    // --- Phase 2: Greedy block matching (exact line-by-line) ---
    // For each del-block, find the longest exact match against an add-block.
    // Track which add-block lines are claimed to ensure one-to-one matching.
    // Rewind: if a match fails the size filter, retry from the next del line.

    const addLineClaimed: Set<number>[] = addBlocks.map(() => new Set<number>())

    interface MoveMatch {
        delBlockIdx : number
        addBlockIdx : number
        delStart    : number // line offset within del-block
        delLen      : number // number of matched lines
        addStart    : number // line offset within add-block
    }

    const moveMatches: MoveMatch[] = []

    for (let dIdx = 0; dIdx < delBlocks.length; dIdx++) {
        const delBlock = delBlocks[dIdx]
        let dLine = 0

        while (dLine < delBlock.lines.length) {
            let bestMatch: {aIdx: number, aStart: number, len: number} | null = null

            for (let aIdx = 0; aIdx < addBlocks.length; aIdx++) {
                const addBlock = addBlocks[aIdx]
                const claimed = addLineClaimed[aIdx]

                for (let aStart = 0; aStart < addBlock.lines.length; aStart++) {
                    if (claimed.has(aStart)) {
                        continue
                    }

                    let len = 0

                    while (
                        dLine + len < delBlock.lines.length
                        && aStart + len < addBlock.lines.length
                        && !claimed.has(aStart + len)
                        && delBlock.lines[dLine + len] === addBlock.lines[aStart + len]
                    ) {
                        len++
                    }

                    if (len > 0 && (!bestMatch || len > bestMatch.len)) {
                        bestMatch = {aIdx, aStart, len}
                    }
                }
            }

            if (bestMatch) {
                // Size filter: count alnum chars across matched del lines
                let alnumCount = 0

                for (let i = 0; i < bestMatch.len; i++) {
                    alnumCount += countAlnum(delBlock.lines[dLine + i])
                }

                if (alnumCount >= COLOR_MOVED_MIN_ALNUM_COUNT) {
                    moveMatches.push({
                        delBlockIdx : dIdx,
                        addBlockIdx : bestMatch.aIdx,
                        delStart    : dLine,
                        delLen      : bestMatch.len,
                        addStart    : bestMatch.aStart,
                    })

                    for (let i = 0; i < bestMatch.len; i++) {
                        addLineClaimed[bestMatch.aIdx].add(bestMatch.aStart + i)
                    }

                    dLine += bestMatch.len
                } else {
                    // Size filter failed — rewind: try from next del line
                    dLine++
                }
            } else {
                // No match found — advance to next del line
                dLine++
            }
        }
    }

    if (moveMatches.length === 0) {
        return
    }

    // --- Phase 3: Mark lines as moved with zebra striping ---
    // Each matched block gets a unique moveId so adjacent blocks receive
    // different colors via the renderer's `moveId % 5` color cycling.

    let nextMoveId = 0

    for (const match of moveMatches) {
        const delBlock = delBlocks[match.delBlockIdx]
        const addBlock = addBlocks[match.addBlockIdx]
        const moveId = nextMoveId++

        for (let i = 0; i < match.delLen; i++) {
            const pos = delBlock.startPos + match.delStart + i
            leftLines[pos].kind = 'moved'
            leftLines[pos].moveId = moveId
        }

        for (let i = 0; i < match.delLen; i++) {
            const pos = addBlock.startPos + match.addStart + i
            rightLines[pos].kind = 'moved'
            rightLines[pos].moveId = moveId
        }

        const delStart = delBlock.startPos + match.delStart
        const delEnd = delStart + match.delLen
        const addStart = addBlock.startPos + match.addStart
        const addEnd = addStart + match.delLen

        const connectorStart = Math.min(delEnd, addEnd)
        const connectorEnd = Math.max(delStart, addStart)

        for (let i = connectorStart; i < connectorEnd; i++) {
            leftLines[i].moveConnector = moveId
            rightLines[i].moveConnector = moveId
        }
    }
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
            if (leftLines[i].kind === 'removed' || leftLines[i].kind === 'moved') {
                snapLines.push(leftLines[i].content)
                snapLine++
            }

            if (rightLines[i].kind === 'added' || rightLines[i].kind === 'moved') {
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
