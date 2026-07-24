export function createRenderController(app) {
    const {dom, state} = app

    function syncDiffLineHeights() {
        if (state.unified || dom.diffContainer.classList.contains('same-content')) {
            return
        }

        const leftRows = dom.leftLines.children
        const rightRows = dom.rightLines.children

        for (let index = 0; index < Math.max(leftRows.length, rightRows.length); index++) {
            if (leftRows[index]) {
                leftRows[index].style.height = ''
            }

            if (rightRows[index]) {
                rightRows[index].style.height = ''
            }
        }

        const heights = []

        for (let index = 0; index < Math.min(leftRows.length, rightRows.length); index++) {
            heights[index] = Math.max(
                leftRows[index].getBoundingClientRect().height,
                rightRows[index].getBoundingClientRect().height,
            )
        }

        for (let index = 0; index < heights.length; index++) {
            leftRows[index].style.height = heights[index] + 'px'
            rightRows[index].style.height = heights[index] + 'px'
        }
    }

    function updateLineNumberGutter() {
        let digits = 1
        document.querySelectorAll('.ln-num').forEach((lineNumber) => {
            digits = Math.max(digits, lineNumber.textContent.length)
        })
        dom.diffContainer.style.setProperty('--line-number-digits', digits)
    }

    function restoreExpandedRegions(regionIds) {
        regionIds.forEach((regionId) => {
            document.querySelectorAll(`.region-block[data-region="${regionId}"]`).forEach((block) => {
                block.style.transition = 'none'
                block.classList.add('expanded')
                block.style.height = block.scrollHeight + 'px'
            })

            const count = document.querySelector(`.unchanged-region[data-region="${regionId}"]`)?.dataset.count || '?'
            app.updateRegionLabels(regionId, 'Hide ' + count + ' unchanged lines')
        })
    }

    function restoreInitialCursor(message) {
        if (!message.initialCursorLine) {
            return
        }

        requestAnimationFrame(() => setTimeout(() => {
            const container = state.unified ? dom.unifiedLines : dom.rightLines
            const target = app.scroll.findClosestLine(container, message.initialCursorLine)

            if (!target) {
                return
            }

            const collapsedRegion = target.closest('.region-block:not(.expanded)')

            if (collapsedRegion) {
                const regionId = collapsedRegion.dataset.region
                document.querySelectorAll(`.region-block[data-region="${regionId}"]`).forEach((block) => {
                    block.style.transition = 'none'
                    block.classList.add('expanded')
                    block.style.height = block.scrollHeight + 'px'
                })
                collapsedRegion.offsetHeight
                const count = document.querySelector(`.unchanged-region[data-region="${regionId}"]`)?.dataset.count || '?'
                app.updateRegionLabels(regionId, 'Hide ' + count + ' unchanged lines')
            }

            const flashElement = (element) => {
                element.classList.add('cursor-flash')
                element.addEventListener('animationend', () => element.classList.remove('cursor-flash'), {once: true})
            }
            const flashTarget = () => {
                flashElement(target)

                if (!state.unified && container === dom.rightLines) {
                    const pair = dom.leftLines.querySelector(`.line[data-line="${target.getAttribute('data-line')}"]`)
                    if (pair) {
                        flashElement(pair)
                    }
                }
            }
            const pane = state.unified ? dom.unifiedPane : dom.rightPaneBody
            const paneRect = pane.getBoundingClientRect()
            const targetRect = target.getBoundingClientRect()
            const targetScroll = pane.scrollTop + targetRect.top - paneRect.top - pane.clientHeight / 2
            app.scroll.animateScroll(pane, targetScroll, () => setTimeout(flashTarget, 50))
        }, 150))
    }

    function handleRenderMessage(message) {
        if (state.totalSnapshotCount > 0 && message.snapshotIndex !== state.currentSnapshotIndex) {
            return
        }

        if (message.mode !== (state.requestedUnified ? 'unified' : 'side-by-side')) {
            return
        }

        app.setViewMode(message.mode === 'unified')
        const expandedRegions = new Set()
        document.querySelectorAll('.region-block.expanded').forEach((block) => expandedRegions.add(block.dataset.region))
        const scrollRestore = state.pendingScrollRestore
        const scrollLine = state.pendingScrollLine
        const undoAnimation = state.pendingUndoAnimation
        state.pendingScrollRestore = null
        state.pendingScrollLine = null
        state.pendingUndoAnimation = null
        app.diffActions.clearHunkAnimations()

        if (!scrollRestore && scrollLine === null) {
            dom.leftPaneBody.scrollTop = 0
            dom.rightPaneBody.scrollTop = 0
            dom.unifiedPane.scrollTop = 0
        }

        dom.leftLines.innerHTML = message.leftHtml

        if (message.rightHtml !== state.cachedRightHtml) {
            dom.rightLines.innerHTML = message.rightHtml
            state.cachedRightHtml = message.rightHtml
        }

        dom.unifiedLines.innerHTML = message.unifiedHtml

        if (state.pinnedLines.size > 0) {
            app.restorePinState()
        }

        if (state.searchOpen && dom.searchInput.value) {
            app.search.performSearch()
        }

        if (undoAnimation) {
            app.diffActions.animateUndo(undoAnimation)
        }

        updateLineNumberGutter()
        app.timeline.updateNavigation(message)
        dom.diffContainer.classList.toggle('same-content', !message.hasChanges)
        app.scroll.updateScrollButton()
        dom.restoreBtn.hidden = !message.hasChanges
        dom.unifiedRestoreBtn.hidden = !message.hasChanges
        dom.undoBtn.classList.toggle('visible', message.hasUndo)
        state.unified = state.requestedUnified
        dom.diffContainer.focus()
        app.hideDiffLoading()

        requestAnimationFrame(() => {
            restoreExpandedRegions(expandedRegions)
            syncDiffLineHeights()

            if (scrollLine !== null) {
                const container = state.unified ? dom.unifiedLines : dom.leftLines
                const target = app.scroll.findClosestLine(container, scrollLine.line)

                if (target) {
                    const pane = state.unified ? dom.unifiedPane : dom.leftPaneBody
                    const paneRect = pane.getBoundingClientRect()
                    const targetRect = target.getBoundingClientRect()
                    pane.scrollTop += targetRect.top - paneRect.top - scrollLine.topOffset
                }
            } else if (scrollRestore) {
                dom.leftPaneBody.scrollTop = scrollRestore.leftTop
                dom.leftPaneBody.scrollLeft = scrollRestore.leftLeft
                dom.rightPaneBody.scrollTop = scrollRestore.rightTop
                dom.rightPaneBody.scrollLeft = scrollRestore.rightLeft
                dom.unifiedPane.scrollTop = scrollRestore.unifiedTop
                dom.unifiedPane.scrollLeft = scrollRestore.unifiedLeft
            } else {
                restoreInitialCursor(message)
            }

            app.scroll.updateScrollButton()
            document.body.classList.remove('cloak')
        })
    }

    return {handleRenderMessage, syncDiffLineHeights}
}
