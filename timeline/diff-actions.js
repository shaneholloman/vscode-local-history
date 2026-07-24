export function createDiffActionsController(app) {
    const {dom, state} = app
    const activatingHunks = new Set()
    const pendingHunkActions = new Set()
    const pendingReverseAnimations = new Set()
    const hunkAnimationMs = 180
    let regionToggleTimer = 0
    let contextTarget = null

    function clearHunkAnimations() {
        pendingHunkActions.forEach((timer) => window.clearTimeout(timer))
        pendingHunkActions.clear()
        pendingReverseAnimations.forEach((timer) => window.clearTimeout(timer))
        pendingReverseAnimations.clear()
        state.pendingScrollRestore = null
        activatingHunks.clear()
        document.querySelectorAll('.hunk-changing, .hunk-reversing').forEach((line) => {
            line.classList.remove('hunk-changing', 'hunk-reversing')
        })
    }

    function undo() {
        state.pendingScrollRestore = app.scroll.captureScrollPosition()
        state.pendingUndoAnimation = state.lastHunkAction
        state.lastHunkAction = null
        app.vscode.postMessage({type: 'undo'})
    }

    function scheduleHunkAction(actionMessage) {
        const timer = window.setTimeout(() => {
            pendingHunkActions.delete(timer)
            state.pendingScrollRestore = app.scroll.captureScrollPosition()
            state.lastHunkAction = actionMessage
            app.vscode.postMessage(actionMessage)
        }, hunkAnimationMs)
        pendingHunkActions.add(timer)
    }

    function animateUndo(actionMessage) {
        const selector = actionMessage.type === 'apply-line'
            ? `.clickable-hunk[data-hunk="${actionMessage.hunkIndex}"][data-i="${actionMessage.alignedIndex}"]`
            : `.clickable-hunk[data-hunk="${actionMessage.index}"]`
        const lines = document.querySelectorAll(selector)

        lines.forEach((line) => line.classList.add('hunk-reversing'))

        if (lines.length === 0) {
            return
        }

        const timer = window.setTimeout(() => {
            pendingReverseAnimations.delete(timer)
            lines.forEach((line) => line.classList.remove('hunk-reversing'))
        }, hunkAnimationMs)
        pendingReverseAnimations.add(timer)
    }

    function activateHunk(line) {
        const hunkIndex = line.dataset.hunk

        if (activatingHunks.has(hunkIndex)) {
            return
        }

        activatingHunks.add(hunkIndex)
        document.querySelectorAll(`.clickable-hunk[data-hunk="${hunkIndex}"]`).forEach((hunkLine) => {
            hunkLine.classList.add('hunk-changing')
        })
        scheduleHunkAction({
            type  : line.dataset.action === 'add' ? 'apply-hunk' : 'reject-hunk',
            index : parseInt(hunkIndex),
        })
    }

    function activateLine(line) {
        const hunkIndex = line.dataset.hunk
        const alignedIndex = parseInt(line.dataset.i)
        const action = line.dataset.action
        const key = hunkIndex + '-' + alignedIndex

        if (isNaN(alignedIndex) || activatingHunks.has(key)) {
            return
        }

        activatingHunks.add(key)
        line.classList.add('hunk-changing')
        scheduleHunkAction({type: 'apply-line', hunkIndex: parseInt(hunkIndex), alignedIndex, action})
    }

    function toggleRegion(toggle) {
        const region = toggle.dataset.region
        const blocks = document.querySelectorAll(`.region-block[data-region="${region}"]`)
        const expanded = blocks.length > 0 && blocks[0].classList.contains('expanded')
        const label = (expanded ? 'Show' : 'Hide') + ' ' + toggle.dataset.count + ' unchanged lines'
        const pane = toggle.closest('.diff-pane-body') || app.scroll.getScrollPane()
        window.clearTimeout(regionToggleTimer)

        blocks.forEach((block) => {
            if (expanded) {
                block.style.height = block.getBoundingClientRect().height + 'px'
                block.offsetHeight
                block.classList.remove('expanded')
                block.style.height = '0'
            } else {
                block.classList.add('expanded')
                block.style.height = '0'
                block.offsetHeight
                block.style.height = block.scrollHeight + 'px'
            }
        })

        app.updateRegionLabels(region, label)
        regionToggleTimer = window.setTimeout(() => requestAnimationFrame(() => {
            blocks.forEach((block) => block.style.height = '')
            app.syncDiffLineHeights()

            const targetLine = expanded
                ? pane.querySelector(`.region-block[data-region="${region}"] + .line[data-line]`)
                : blocks[0]?.querySelector('.line[data-line]')

            if (targetLine) {
                const paneRect = pane.getBoundingClientRect()
                const targetRect = targetLine.getBoundingClientRect()

                if (targetRect.bottom < paneRect.top || targetRect.top > paneRect.bottom) {
                    pane.scrollTop += targetRect.top - paneRect.top
                }
            }
        }), 350)
    }

    function activateDiffTarget(target, event) {
        const hunk = target.closest('.clickable-hunk')
        const region = target.closest('.clickable-region')

        if (hunk) {
            if (event?.metaKey || event?.ctrlKey) {
                activateLine(hunk)
            } else {
                activateHunk(hunk)
            }
        } else if (region) {
            toggleRegion(region)
        }
    }

    function getLineContent(line) {
        const lineContent = line.querySelector('.ln')

        return lineContent ? lineContent.textContent : ''
    }

    function getHunkContent(hunkIndex, container) {
        const lines = []
        container.querySelectorAll(`.clickable-hunk[data-hunk="${hunkIndex}"]`).forEach((line) => {
            lines.push(getLineContent(line))
        })

        let start = 0
        let end = lines.length

        while (start < end && lines[start] === '') {
            start++
        }

        while (end > start && lines[end - 1] === '') {
            end--
        }

        return lines.slice(start, end).join('\n')
    }

    function hideContextMenu() {
        dom.contextMenu.style.display = 'none'
        contextTarget = null
    }

    function showContextMenu(event, line) {
        contextTarget = line
        const isHunk = line.matches('.clickable-hunk')
        const lineNum = line.getAttribute('data-line')
        const copyLineBtn = dom.contextMenu.querySelector('[data-action="copy-line"]')
        copyLineBtn.textContent = lineNum ? `Copy line (${lineNum})` : 'Copy line'
        const hunkBtn = dom.contextMenu.querySelector('[data-action="copy-hunk"]')

        if (isHunk) {
            const hunkLines = line.closest('.code-lines').querySelectorAll(`.clickable-hunk[data-hunk="${line.dataset.hunk}"]`)
            let min = Infinity
            let max = -Infinity

            hunkLines.forEach((hunkLine) => {
                const number = parseInt(hunkLine.getAttribute('data-line'))

                if (!isNaN(number)) {
                    min = Math.min(min, number)
                    max = Math.max(max, number)
                }
            })

            hunkBtn.textContent = min !== Infinity ? `Copy hunk (${min}~${max})` : 'Copy hunk'
            hunkBtn.style.display = ''
        } else {
            hunkBtn.style.display = 'none'
        }

        dom.contextMenu.style.display = 'block'
        const scale = state.zoom / 100
        const menuWidth = dom.contextMenu.offsetWidth / scale
        const menuHeight = dom.contextMenu.offsetHeight / scale
        const viewWidth = window.innerWidth / scale
        const viewHeight = window.innerHeight / scale
        dom.contextMenu.style.left = Math.min(event.clientX / scale, viewWidth - menuWidth - 4) + 'px'
        dom.contextMenu.style.top = Math.min(event.clientY / scale, viewHeight - menuHeight - 4) + 'px'
    }

    function bind() {
        dom.diffContainer.addEventListener('click', (event) => {
            if (!(event.target instanceof Element)) {
                return
            }

            const lineNumberElement = event.target.closest('.ln-num')
            const line = lineNumberElement?.closest('.line[data-line]')

            if (line) {
                const lineNumber = parseInt(line.dataset.line)

                if (!isNaN(lineNumber)) {
                    app.togglePinLine(lineNumber)

                    return
                }
            }

            activateDiffTarget(event.target, event)
        })
        dom.diffContainer.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
                return
            }

            if (event.target instanceof Element && event.target.closest('.clickable-hunk, .clickable-region')) {
                event.preventDefault()
                activateDiffTarget(event.target, event)
            }
        })
        dom.diffContainer.addEventListener('contextmenu', (event) => {
            if (!(event.target instanceof Element)) {
                return
            }

            const line = event.target.closest('.line')

            if (!line) {
                return
            }

            event.preventDefault()

            if (!line.classList.contains('diff-empty')) {
                showContextMenu(event, line)
            }
        })
        dom.contextMenu.addEventListener('click', (event) => {
            const button = event.target.closest('.ctx-item')

            if (!button || !contextTarget) {
                return
            }

            if (button.dataset.action === 'copy-line') {
                navigator.clipboard.writeText(getLineContent(contextTarget)).catch(() => {})
            } else if (button.dataset.action === 'copy-hunk' && contextTarget.matches('.clickable-hunk')) {
                const container = contextTarget.closest('.code-lines')
                navigator.clipboard.writeText(getHunkContent(contextTarget.dataset.hunk, container)).catch(() => {})
            }

            hideContextMenu()
        })
        document.addEventListener('pointerdown', (event) => {
            if (dom.contextMenu.style.display === 'block' && !dom.contextMenu.contains(event.target)) {
                hideContextMenu()
            }
        })
    }

    return {
        animateUndo,
        bind,
        clearHunkAnimations,
        hideContextMenu,
        isContextMenuOpen: () => dom.contextMenu.style.display === 'block',
        undo,
    }
}
