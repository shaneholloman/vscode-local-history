(function() {
    const vscode = acquireVsCodeApi()
    const leftLines = document.getElementById('leftLines')
    const rightLines = document.getElementById('rightLines')
    const unifiedLines = document.getElementById('unifiedLines')
    const counter = document.getElementById('counter')
    const prevBtn = document.getElementById('prevBtn')
    const nextBtn = document.getElementById('nextBtn')
    const restoreBtn = document.getElementById('restoreBtn')
    const unifiedRestoreBtn = document.getElementById('unifiedRestoreBtn')
    const openFileBtn = document.getElementById('openFileBtn')
    const unifiedOpenFileBtn = document.getElementById('unifiedOpenFileBtn')
    const undoBtn = document.getElementById('undoBtn')
    const viewToggle = document.getElementById('viewToggle')
    const zoomOutBtn = document.getElementById('zoomOutBtn')
    const zoomResetBtn = document.getElementById('zoomResetBtn')
    const zoomInBtn = document.getElementById('zoomInBtn')
    const scrollTopBtn = document.getElementById('scrollTopBtn')
    const diffContainer = document.querySelector('.diff-container')
    const loadingIndicator = document.querySelector('.loading-indicator')
    const hoverTooltip = document.getElementById('hoverTooltip')
    const leftPane = document.getElementById('leftPane')
    const leftPaneBody = leftPane.querySelector('.diff-pane-body')
    const rightPane = document.getElementById('rightPane')
    const rightPaneBody = rightPane.querySelector('.diff-pane-body')
    const unifiedPane = document.getElementById('unifiedPane')
    const timelineStrip = document.getElementById('timelineStrip')
    let webviewActive = true
    let diffLoading = false

    function setDiffLoadingVisible(visible) {
        diffContainer.classList.toggle('loading', visible)
        loadingIndicator.classList.toggle('visible', visible)
    }

    function showDiffLoading() {
        diffLoading = true
        setDiffLoadingVisible(webviewActive)
    }

    function hideDiffLoading() {
        diffLoading = false
        setDiffLoadingVisible(false)
    }

    const breakpoint = Number(document.body.dataset.breakpoint)
    let userChoice = null // null = use default, true/false = user override
    let unified = document.body.dataset.initialUnified === 'true'
    let requestedUnified = unified
    let zoom = 100
    let tooltipTarget = null
    let metaPressed = false
    let currentSnapshotIndex = 0
    let totalSnapshotCount = 0
    let snapshotDates = []
    let cachedRightHtml = null
    let webviewReady = false
    const hunkAnimationMs = 180
    document.documentElement.style.setProperty('--line-height', document.body.dataset.lineHeight || '1.5em')

    const SBS_BLOCKED_MSG = 'Side-by-side mode is not currently available. Disable "diffEditor.useInlineViewWhenSpaceIsLimited" or increase the editor width.'

    function notifySbsBlocked() {
        vscode.postMessage({type: 'show-notification', message: SBS_BLOCKED_MSG})
    }

    function applyZoom() {
        document.body.style.zoom = zoom + '%'
        zoomResetBtn.textContent = zoom + '%'
        hideTooltip()
        requestAnimationFrame(syncDiffLineHeights)
    }

    function changeZoom(amount) {
        zoom = Math.max(50, Math.min(200, zoom + amount))
        applyZoom()
    }

    function setZoom(zoomValue) {
        zoom = zoomValue
        applyZoom()
    }

    function hideTooltip() {
        tooltipTarget = null
        hoverTooltip.classList.remove('visible')
    }

    function positionTooltip(x, y) {
        const scale = zoom / 100
        const viewportWidth = window.innerWidth / scale
        const viewportHeight = window.innerHeight / scale
        const tooltipRect = hoverTooltip.getBoundingClientRect()
        const tooltipWidth = tooltipRect.width / scale
        const tooltipHeight = tooltipRect.height / scale
        const left = Math.min((x + 12) / scale, viewportWidth - tooltipWidth - 8 / scale)
        const below = (y + 18) / scale
        const above = (y - 8) / scale - tooltipHeight
        const top = below + tooltipHeight <= viewportHeight - 8 / scale
            ? below
            : above

        hoverTooltip.style.left = Math.max(8 / scale, left) + 'px'
        hoverTooltip.style.top = Math.max(8 / scale, top) + 'px'
    }

    function showTooltip(target, x, y, event) {
        tooltipTarget = target

        if (event) {
            metaPressed = event.metaKey || event.ctrlKey
        }

        hoverTooltip.textContent = getTooltipText(target)
        hoverTooltip.classList.add('visible')

        const targetRect = target.getBoundingClientRect()
        positionTooltip(x ?? targetRect.left, y ?? targetRect.top)
    }

    function getTooltipText(target) {
        let text = target.dataset.tooltip

        if (metaPressed && target.closest('.clickable-hunk')) {
            const lineNum = target.dataset.line
            text = text.replace('this change', lineNum ? `this line (line ${lineNum})` : 'this line')
        }

        return text
    }

    function refreshTooltipText() {
        if (tooltipTarget && hoverTooltip.classList.contains('visible')) {
            hoverTooltip.textContent = getTooltipText(tooltipTarget)
        }
    }

    function getTooltipTarget(event) {
        return event?.target instanceof Element
            ? event.target.closest('[data-tooltip]')
            : null
    }

    document.addEventListener('pointerover', (event) => {
        const target = getTooltipTarget(event)

        if (target) {
            showTooltip(target, event.clientX, event.clientY, event)
        }
    })
    document.addEventListener('pointermove', (event) => {
        const target = getTooltipTarget(event)

        if (target !== tooltipTarget) {
            if (target) {
                showTooltip(target, event.clientX, event.clientY, event)
            } else {
                hideTooltip()
            }
        } else if (target) {
            positionTooltip(event.clientX, event.clientY)
        }
    })

    function hideTooltipOnLeave(event) {
        const relatedTarget = event.relatedTarget

        if (!tooltipTarget || (relatedTarget instanceof Node && tooltipTarget.contains(relatedTarget))) {
            return
        }

        hideTooltip()
    }

    document.addEventListener('pointerout', hideTooltipOnLeave)
    document.addEventListener('focusin', (event) => {
        const target = getTooltipTarget(event)

        if (target) {
            showTooltip(target)
        }
    })
    document.addEventListener('focusout', hideTooltipOnLeave)

    function onModifierKeyChange(e) {
        const newState = e.metaKey || e.ctrlKey

        if (newState !== metaPressed) {
            metaPressed = newState
            refreshTooltipText()
        }
    }

    document.addEventListener('keydown', onModifierKeyChange)
    document.addEventListener('keyup', onModifierKeyChange)
    window.addEventListener('blur', () => {
        if (metaPressed) {
            metaPressed = false
            refreshTooltipText()
        }
    })

    zoomOutBtn.addEventListener('click', () => changeZoom(-10))
    zoomResetBtn.addEventListener('click', () => setZoom(100))
    zoomInBtn.addEventListener('click', () => changeZoom(10))

    function setViewMode(showUnified) {
        unified = showUnified
        diffContainer.classList.toggle('unified-mode', unified)
        viewToggle.textContent = unified ? 'Side-by-side' : 'Unified'
        viewToggle.dataset.tooltip = unified ? 'Switch to side-by-side mode' : 'Switch to unified mode'
    }

    function requestViewMode(showUnified) {
        if (requestedUnified === showUnified && diffLoading) {
            return
        }

        requestedUnified = showUnified
        showDiffLoading()
        vscode.postMessage({type: 'render-mode', mode: showUnified ? 'unified' : 'side-by-side'})
    }

    function applyView() {
        let showUnified

        if (window.innerWidth < breakpoint) {
            showUnified = true
        } else if (userChoice !== null) {
            showUnified = userChoice
        } else {
            showUnified = document.body.dataset.initialUnified === 'true'
        }

        if (!webviewReady) {
            requestedUnified = showUnified
            setViewMode(showUnified)
        } else if (showUnified !== unified || showUnified !== requestedUnified) {
            pendingScrollLine = captureVisibleLine()
            requestViewMode(showUnified)

            return
        } else {
            setViewMode(showUnified)
            updateScrollButton()

            return
        }

        updateScrollButton()
        requestAnimationFrame(syncDiffLineHeights)
    }

    function toggleViewMode() {
        if (window.innerWidth < breakpoint && unified) {
            notifySbsBlocked()

            return
        }

        userChoice = !unified
        applyView()
    }

    viewToggle.addEventListener('click', toggleViewMode)

    let resizeTimer

    window.addEventListener('resize', () => {
        if (window.stripWidth !== document.body.clientWidth) {
            window.stripWidth = document.body.clientWidth
            clearTimeout(resizeTimer)

            resizeTimer = setTimeout(() => {
                if (requestedUnified === unified) {
                    applyView()
                } else {
                    showDiffLoading()
                    applyView()
                }
            }, 200)
        }
    })

    window.addEventListener('scroll', hideTooltip, true)
    applyView()

    timelineStrip.addEventListener('wheel', (event) => {
        if (event.deltaY === 0) {
            return
        }

        event.preventDefault()
        timelineStrip.scrollLeft -= event.deltaY
    }, {passive: false})

    function navigate(direction, keyboard = false) {
        if (!previewNavigation(direction)) {
            return
        }

        showDiffLoading()
        const message = {type: 'navigate', direction}

        if (keyboard) {
            message.keyboard = true
        }

        vscode.postMessage(message)
    }

    prevBtn.addEventListener('click', () => navigate('prev'))
    nextBtn.addEventListener('click', () => navigate('next'))
    restoreBtn.addEventListener('click', () => vscode.postMessage({type: 'restore'}))
    unifiedRestoreBtn.addEventListener('click', () => vscode.postMessage({type: 'restore'}))
    openFileBtn.addEventListener('click', () => vscode.postMessage({type: 'open-snapshot'}))
    unifiedOpenFileBtn.addEventListener('click', () => vscode.postMessage({type: 'open-snapshot'}))
    undoBtn.addEventListener('click', undo)
    scrollTopBtn.addEventListener('click', () => scrollToTopBottom())

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault()
            toggleViewMode()
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault()
            navigate('prev', true)
        } else if (e.key === 'ArrowRight') {
            e.preventDefault()
            navigate('next', true)
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown') {
            e.preventDefault()
            scrollToTopBottom('bottom')
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowUp') {
            e.preventDefault()
            scrollToTopBottom('top')
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const pane = unified ? unifiedPane : leftPaneBody
            pane.scrollBy({top: e.key === 'ArrowUp' ? -40 : 40})
        } else if (e.key === 'Escape') {
            e.preventDefault()

            if (ctxMenu.style.display === 'block') {
                hideContextMenu()
            } else {
                vscode.postMessage({type: 'close'})
            }
        } else if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
            e.preventDefault()
            changeZoom(10)
        } else if ((e.metaKey || e.ctrlKey) && e.key === '-') {
            e.preventDefault()
            changeZoom(-10)
        } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
            e.preventDefault()
            setZoom(100)
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
            e.preventDefault()
            undo()
        }
    })

    function updateNavigation(msg) {
        currentSnapshotIndex = msg.snapshotIndex
        totalSnapshotCount = msg.totalCount
        snapshotDates = msg.snapshotDates
        counter.textContent = msg.currentIndex + ' / ' + msg.totalCount
        prevBtn.disabled = !msg.hasPrev
        nextBtn.disabled = !msg.hasNext
        buildTimelineBars(msg.snapshotDates, msg.snapshotIndex)
    }

    function updateLineNumberGutter() {
        let digits = 1
        document.querySelectorAll('.ln-num').forEach((lineNumber) => {
            digits = Math.max(digits, lineNumber.textContent.length)
        })
        diffContainer.style.setProperty('--line-number-digits', digits)
    }

    function syncDiffLineHeights() {
        if (unified || diffContainer.classList.contains('same-content')) {
            return
        }

        const leftRows = leftLines.children
        const rightRows = rightLines.children

        // Reset first — write batch
        for (let i = 0; i < Math.max(leftRows.length, rightRows.length); i++) {
            if (leftRows[i]) {
                leftRows[i].style.height = ''
            }

            if (rightRows[i]) {
                rightRows[i].style.height = ''
            }
        }

        // Read all heights — forces layout once
        const heights = []

        for (let i = 0; i < Math.min(leftRows.length, rightRows.length); i++) {
            heights[i] = Math.max(
                leftRows[i].getBoundingClientRect().height,
                rightRows[i].getBoundingClientRect().height,
            )
        }

        // Write all heights — one paint trigger
        for (let i = 0; i < heights.length; i++) {
            leftRows[i].style.height = heights[i] + 'px'
            rightRows[i].style.height = heights[i] + 'px'
        }
    }

    function previewNavigation(direction) {
        const nextIndex = currentSnapshotIndex + (direction === 'prev' ? 1 : -1)

        if (nextIndex < 0 || nextIndex >= totalSnapshotCount) {
            return false
        }

        updateNavigation({
            currentIndex  : totalSnapshotCount - nextIndex,
            totalCount    : totalSnapshotCount,
            hasPrev       : nextIndex < totalSnapshotCount - 1,
            hasNext       : nextIndex > 0,
            snapshotDates,
            snapshotIndex : nextIndex,
        })

        return true
    }

    window.addEventListener('message', (event) => {
        const msg = event.data

        if (msg.type === 'zoom') {
            if (msg.action === 'in') {
                changeZoom(10)
            }

            if (msg.action === 'out') {
                changeZoom(-10)
            }

            if (msg.action === 'reset') {
                setZoom(100)
            }

            return
        }

        if (msg.type === 'viewState') {
            webviewActive = msg.active

            // The webview DOM persists (retainContextWhenHidden), so content
            // is already correct on return. A side-by-side split keeps the
            // panel visible -> never cloak. Only when the panel is REPLACED
            // by another editor (the only visible tab) do we hide via cloak.
            if (msg.visible) {
                document.body.classList.remove('cloak')
            } else {
                document.body.classList.add('cloak')
            }

            if (msg.active) {
                pendingScrollRestore = captureScrollPosition()
                requestAnimationFrame(() => {
                    applyView()
                    updateScrollButton()
                })
            }

            return
        }

        if (msg.type === 'action-result') {
            if (!msg.applied) {
                lastHunkAction = null
                pendingUndoAnimation = null
                clearHunkAnimations()
            }

            return
        }

        if (msg.type === 'undo-command') {
            undo()

            return
        }

        if (msg.type === 'render') {
            if (totalSnapshotCount > 0 && msg.snapshotIndex !== currentSnapshotIndex) {
                return
            }

            const renderedUnified = msg.mode === 'unified'

            if (renderedUnified !== requestedUnified) {
                return
            }

            setViewMode(renderedUnified)

            // Capture expanded regions before DOM is replaced
            const expandedRegions = new Set()
            document.querySelectorAll('.region-block.expanded').forEach((block) => {
                expandedRegions.add(block.dataset.region)
            })

            const scrollRestore = pendingScrollRestore
            const scrollLine = pendingScrollLine
            const undoAnimation = pendingUndoAnimation
            pendingScrollRestore = null
            pendingScrollLine = null
            pendingUndoAnimation = null
            clearHunkAnimations()

            if (!scrollRestore && scrollLine === null) {
                leftPaneBody.scrollTop = 0
                rightPaneBody.scrollTop = 0
                unifiedPane.scrollTop = 0
            }

            leftLines.innerHTML = msg.leftHtml

            if (msg.rightHtml !== cachedRightHtml) {
                rightLines.innerHTML = msg.rightHtml
                cachedRightHtml = msg.rightHtml
            }

            unifiedLines.innerHTML = msg.unifiedHtml

            if (undoAnimation) {
                animateUndo(undoAnimation)
            }

            updateLineNumberGutter()
            updateNavigation(msg)
            diffContainer.classList.toggle('same-content', !msg.hasChanges)
            updateScrollButton()
            restoreBtn.hidden = !msg.hasChanges
            unifiedRestoreBtn.hidden = !msg.hasChanges
            undoBtn.classList.toggle('visible', msg.hasUndo)

            unified = requestedUnified
            diffContainer.focus()
            hideDiffLoading()
            requestAnimationFrame(() => {
                // Restore expanded regions — suppress transition so the snap from
                // height:0 (fresh HTML) to full height is invisible.
                expandedRegions.forEach((regionId) => {
                    document.querySelectorAll(`.region-block[data-region="${regionId}"]`).forEach((block) => {
                        block.style.transition = 'none'
                        block.classList.add('expanded')
                        block.style.height = block.scrollHeight + 'px'

                        const hideLabel = 'Hide ' + (document.querySelector(`.unchanged-region[data-region="${regionId}"]`)?.dataset.count || '?') + ' unchanged lines'
                        document.querySelectorAll(`.clickable-region[data-region="${regionId}"]`).forEach((button) => {
                            button.dataset.tooltip = hideLabel
                            button.setAttribute('aria-label', hideLabel)
                        })
                        document.querySelectorAll(`.hidden-label[data-region-label="${regionId}"]`).forEach((labelEl) => {
                            labelEl.textContent = hideLabel
                        })
                    })
                })

                syncDiffLineHeights()

                if (scrollLine !== null) {
                    const container = unified ? unifiedLines : leftLines
                    const lineNum = scrollLine.line
                    let target = container.querySelector(`.line[data-line="${lineNum}"]`)

                    if (!target) {
                        let bestEl = null, bestDiff = Infinity

                        for (const el of container.querySelectorAll('.line[data-line]')) {
                            const ln = parseInt(el.getAttribute('data-line'))
                            const diff = Math.abs(ln - lineNum)

                            if (diff < bestDiff) {
                                bestDiff = diff; bestEl = el
                            }
                        }

                        target = bestEl
                    }

                    if (target) {
                        const pane = unified ? unifiedPane : leftPaneBody
                        const paneRect = pane.getBoundingClientRect()
                        const targetRect = target.getBoundingClientRect()
                        const currentOffset = targetRect.top - paneRect.top
                        pane.scrollTop += currentOffset - scrollLine.topOffset
                    }
                } else if (scrollRestore) {
                    leftPaneBody.scrollTop = scrollRestore.leftTop
                    leftPaneBody.scrollLeft = scrollRestore.leftLeft
                    rightPaneBody.scrollTop = scrollRestore.rightTop
                    rightPaneBody.scrollLeft = scrollRestore.rightLeft
                    unifiedPane.scrollTop = scrollRestore.unifiedTop
                    unifiedPane.scrollLeft = scrollRestore.unifiedLeft
                } else if (msg.initialCursorLine) {
                    requestAnimationFrame(() => {
                        setTimeout(() => {
                            const container = unified ? unifiedLines : rightLines
                            let target = container.querySelector(`.line[data-line="${msg.initialCursorLine}"]`)

                            if (!target) {
                                let bestEl = null, bestDiff = Infinity

                                for (const el of container.querySelectorAll('.line[data-line]')) {
                                    const ln = parseInt(el.getAttribute('data-line'))
                                    const diff = Math.abs(ln - msg.initialCursorLine)

                                    if (diff < bestDiff) {
                                        bestDiff = diff; bestEl = el
                                    }
                                }

                                target = bestEl
                            }

                            if (target) {
                                const collapsedRegion = target.closest('.region-block:not(.expanded)')

                                if (collapsedRegion) {
                                    const regionId = collapsedRegion.dataset.region

                                    document.querySelectorAll(`.region-block[data-region="${regionId}"]`).forEach((block) => {
                                        block.classList.add('expanded')
                                        block.style.height = block.scrollHeight + 'px'
                                    })

                                    const hideLabel = 'Hide ' + (document.querySelector(`.unchanged-region[data-region="${regionId}"]`)?.dataset.count || '?') + ' unchanged lines'

                                    document.querySelectorAll(`.clickable-region[data-region="${regionId}"]`).forEach((button) => {
                                        button.dataset.tooltip = hideLabel
                                        button.setAttribute('aria-label', hideLabel)
                                    })
                                    document.querySelectorAll(`.hidden-label[data-region-label="${regionId}"]`).forEach((labelEl) => {
                                        labelEl.textContent = hideLabel
                                    })
                                }

                                const doFlash = () => {
                                    const flashEl = (el) => {
                                        el.classList.add('cursor-flash')
                                        el.addEventListener('animationend', () => el.classList.remove('cursor-flash'), {once: true})
                                    }

                                    flashEl(target)

                                    if (!unified && container === rightLines) {
                                        const pair = leftLines.querySelector(`.line[data-line="${target.getAttribute('data-line')}"]`)
                                        pair && flashEl(pair)
                                    }
                                }

                                const scrollToTarget = () => {
                                    const pane = unified ? unifiedPane : rightPaneBody
                                    const paneRect = pane.getBoundingClientRect()
                                    const targetRect = target.getBoundingClientRect()
                                    const targetScroll = pane.scrollTop + targetRect.top - paneRect.top - pane.clientHeight / 3
                                    animateScroll(pane, targetScroll, () => setTimeout(doFlash, 50))
                                }

                                if (collapsedRegion) {
                                    setTimeout(scrollToTarget, 50)
                                } else {
                                    scrollToTarget()
                                }
                            }
                        }, 150)
                    })
                }

                document.body.classList.remove('cloak')
            })
        }
    })

    function buildTimelineBars(dates, activeIdx) {
        const existingPoints = timelineStrip.querySelectorAll('.timeline-point')

        if (existingPoints.length === dates.length) {
            existingPoints.forEach((point) => {
                point.classList.toggle('active', Number(point.dataset.index) === activeIdx)
            })
            revealActivePoint(activeIdx)

            return
        }

        const track = document.createElement('div')
        track.className = 'timeline-track'
        timelineStrip.innerHTML = ''

        for (let i = dates.length - 1; i >= 0; i--) {
            const label = dates[i]
            const point = document.createElement('button')
            point.className = 'timeline-point' + (i === activeIdx ? ' active' : '')
            point.type = 'button'
            point.dataset.index = String(i)
            point.setAttribute('aria-label', `Snapshot ${label}`)

            const dot = document.createElement('span')
            dot.className = 'timeline-dot'

            const date = document.createElement('span')
            date.className = 'timeline-date'
            date.textContent = label

            point.append(dot, date)
            point.addEventListener('click', () => {
                if (i === currentSnapshotIndex) {
                    return
                }

                currentSnapshotIndex = i
                showDiffLoading()
                vscode.postMessage({type: 'goto', index: i})
            })
            track.appendChild(point)
        }

        const rail = document.createElement('div')
        rail.className = 'timeline-rail'
        track.appendChild(rail)
        timelineStrip.appendChild(track)
        revealActivePoint(activeIdx)
    }

    function revealActivePoint(activeIdx) {
        const point = timelineStrip.querySelector(`.timeline-point[data-index="${activeIdx}"]`)
        point?.scrollIntoView({block: 'nearest', inline: 'nearest'})
    }

    const activatingHunks = new Set()
    const pendingHunkActions = new Set()
    const pendingReverseAnimations = new Set()
    let pendingScrollRestore = null
    let pendingScrollLine = null
    let pendingUndoAnimation = null
    let lastHunkAction = null
    let regionToggleTimer = 0

    function clearHunkAnimations() {
        pendingHunkActions.forEach((timer) => window.clearTimeout(timer))
        pendingHunkActions.clear()
        pendingReverseAnimations.forEach((timer) => window.clearTimeout(timer))
        pendingReverseAnimations.clear()
        pendingScrollRestore = null
        activatingHunks.clear()
        document.querySelectorAll('.hunk-changing, .hunk-reversing').forEach((line) => {
            line.classList.remove('hunk-changing', 'hunk-reversing')
        })
    }

    function captureScrollPosition() {
        return {
            leftTop     : leftPaneBody.scrollTop,
            leftLeft    : leftPaneBody.scrollLeft,
            rightTop    : rightPaneBody.scrollTop,
            rightLeft   : rightPaneBody.scrollLeft,
            unifiedTop  : unifiedPane.scrollTop,
            unifiedLeft : unifiedPane.scrollLeft,
        }
    }

    function captureVisibleLine() {
        const activePane = unified ? unifiedPane : leftPaneBody
        const container = unified ? unifiedLines : leftLines
        const paneTop = activePane.getBoundingClientRect().top

        for (const el of container.querySelectorAll('.line[data-line]')) {
            if (el.classList.contains('unchanged-region')) {
                continue
            }

            if (el.closest('.region-block:not(.expanded)')) {
                continue
            }

            const rect = el.getBoundingClientRect()

            if (rect.height === 0) {
                continue
            }

            if (rect.bottom > paneTop) {
                return {
                    line      : parseInt(el.getAttribute('data-line')),
                    topOffset : rect.top - paneTop,
                }
            }
        }

        return null
    }

    function restoreScrollLine(capture) {
        if (!capture) {
            return
        }

        const pane = unified ? unifiedPane : leftPaneBody
        const container = unified ? unifiedLines : leftLines
        const target = container.querySelector(`.line[data-line="${capture.line}"]`)

        if (target) {
            const paneRect = pane.getBoundingClientRect()
            const targetRect = target.getBoundingClientRect()
            const currentOffset = targetRect.top - paneRect.top
            pane.scrollTop += currentOffset - capture.topOffset
        }
    }

    function undo() {
        pendingScrollRestore = captureScrollPosition()
        pendingUndoAnimation = lastHunkAction
        lastHunkAction = null
        vscode.postMessage({type: 'undo'})
    }

    function scheduleHunkAction(actionMessage) {
        const timer = window.setTimeout(() => {
            pendingHunkActions.delete(timer)
            pendingScrollRestore = captureScrollPosition()
            lastHunkAction = actionMessage
            vscode.postMessage(actionMessage)
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

    let syncing = false
    let smoothScrollSource = null
    let smoothScrollTarget = 0
    let scrollAnimationFrame = 0

    function getScrollPane() {
        if (unified) {
            return unifiedPane
        }

        return diffContainer.classList.contains('same-content') ? rightPaneBody : leftPaneBody
    }

    function scrollToTopBottom(to) {
        const pane = getScrollPane()
        const atTop = pane.scrollTop <= 0

        if (to === 'top') {
            if (!atTop) {
                animateScroll(pane, 0)
            }
        } else if (to === 'bottom') {
            if (pane.scrollTop < pane.scrollHeight - pane.clientHeight) {
                animateScroll(pane, pane.scrollHeight - pane.clientHeight)
            }
        } else {
            // toggle (button click)
            animateScroll(pane, atTop ? pane.scrollHeight - pane.clientHeight : 0)
        }
    }

    function updateScrollButton() {
        const pane = getScrollPane()

        if (pane.scrollHeight <= pane.clientHeight) {
            scrollTopBtn.classList.add('hidden')

            return
        }

        scrollTopBtn.classList.remove('hidden')
        const atTop = pane.scrollTop <= 0
        scrollTopBtn.classList.toggle('scroll-bottom', atTop)
        scrollTopBtn.dataset.tooltip = atTop ? 'Scroll to bottom' : 'Scroll to top'
        scrollTopBtn.setAttribute('aria-label', scrollTopBtn.dataset.tooltip)
    }

    function animateScroll(pane, target, onDone) {
        cancelAnimationFrame(scrollAnimationFrame)
        target = Math.max(0, Math.min(target, pane.scrollHeight - pane.clientHeight))

        if (target === pane.scrollTop) {
            onDone?.()

            return
        }

        smoothScrollSource = pane
        smoothScrollTarget = target
        const start = pane.scrollTop
        const startedAt = performance.now()

        const step = (timestamp) => {
            const progress = Math.min(1, (timestamp - startedAt) / 180)
            pane.scrollTop = Math.round(start + (target - start) * progress)

            if (progress < 1) {
                scrollAnimationFrame = requestAnimationFrame(step)
            } else {
                onDone?.()
            }
        }

        scrollAnimationFrame = requestAnimationFrame(step)
    }

    function syncPanes(source, target) {
        if (syncing || (smoothScrollSource && source !== smoothScrollSource)) {
            return
        }

        syncing = true
        target.scrollTop = source.scrollTop
        target.scrollLeft = source.scrollLeft
        syncing = false

        if (smoothScrollSource === source && Math.abs(source.scrollTop - smoothScrollTarget) <= 1) {
            smoothScrollSource = null
        }
    }

    function handlePaneScroll(source, target) {
        syncPanes(source, target)
        updateScrollButton()
    }

    leftPaneBody.addEventListener('scroll', () => handlePaneScroll(leftPaneBody, rightPaneBody), {passive: true})
    rightPaneBody.addEventListener('scroll', () => handlePaneScroll(rightPaneBody, leftPaneBody), {passive: true})
    unifiedPane.addEventListener('scroll', updateScrollButton, {passive: true})

    function animateAndActivate(line) {
        const hunkIndex = line.dataset.hunk

        if (activatingHunks.has(hunkIndex)) {
            return
        }

        activatingHunks.add(hunkIndex)
        document.querySelectorAll('.clickable-hunk[data-hunk="' + hunkIndex + '"]').forEach((hunkLine) => {
            hunkLine.classList.add('hunk-changing')
        })
        scheduleHunkAction({
            type  : line.dataset.action === 'add' ? 'apply-hunk' : 'reject-hunk',
            index : parseInt(hunkIndex),
        })
    }

    function animateAndActivateLine(line) {
        const hunkIndex = line.dataset.hunk
        const alignedIndex = parseInt(line.dataset.i)
        const action = line.dataset.action

        if (isNaN(alignedIndex) || activatingHunks.has(hunkIndex + '-' + alignedIndex)) {
            return
        }

        const key = hunkIndex + '-' + alignedIndex
        activatingHunks.add(key)
        line.classList.add('hunk-changing')
        scheduleHunkAction({
            type      : 'apply-line',
            hunkIndex : parseInt(hunkIndex),
            alignedIndex,
            action,
        })
    }

    function toggleRegion(toggle) {
        const region = toggle.dataset.region
        const blocks = document.querySelectorAll('.region-block[data-region="' + region + '"]')
        const expanded = blocks.length > 0 && blocks[0].classList.contains('expanded')
        const label = (expanded ? 'Show' : 'Hide') + ' ' + toggle.dataset.count + ' unchanged lines'
        const pane = toggle.closest('.diff-pane-body') || getScrollPane()
        window.clearTimeout(regionToggleTimer)

        blocks.forEach((block) => {
            if (expanded) {
                const currentHeight = block.getBoundingClientRect().height
                block.style.height = currentHeight + 'px'
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

        document.querySelectorAll('.clickable-region[data-region="' + region + '"]').forEach((button) => {
            button.dataset.tooltip = label
            button.setAttribute('aria-label', label)
        })
        document.querySelectorAll('.hidden-label[data-region-label="' + region + '"]').forEach((labelEl) => {
            labelEl.textContent = label
        })

        regionToggleTimer = window.setTimeout(() => requestAnimationFrame(() => {
            blocks.forEach((block) => {
                block.style.height = ''
            })
            syncDiffLineHeights()

            const targetLine = expanded
                ? pane.querySelector('.region-block[data-region="' + region + '"] + .line[data-line]')
                : blocks[0]?.querySelector('.line[data-line]')

            if (targetLine) {
                const paneRect = pane.getBoundingClientRect()
                const targetRect = targetLine.getBoundingClientRect()
                pane.scrollTop += targetRect.top - paneRect.top
            }
        }), 350)
    }

    function activateDiffTarget(target, event) {
        const hunk = target.closest('.clickable-hunk')
        const region = target.closest('.clickable-region')

        if (hunk) {
            if (event?.metaKey || event?.ctrlKey) {
                animateAndActivateLine(hunk)
            } else {
                animateAndActivate(hunk)
            }
        } else if (region) {
            toggleRegion(region)
        }
    }

    diffContainer.addEventListener('click', (event) => {
        if (event.target instanceof Element) {
            activateDiffTarget(event.target, event)
        }
    })
    diffContainer.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return
        }

        if (!(event.target instanceof Element)) {
            return
        }

        if (!event.target.closest('.clickable-hunk, .clickable-region')) {
            return
        }

        event.preventDefault()
        activateDiffTarget(event.target, event)
    })

    // Context menu for copy line / copy hunk
    const ctxMenu = document.getElementById('ctxMenu')
    let ctxTarget = null

    function hideContextMenu() {
        ctxMenu.style.display = 'none'
        ctxTarget = null
    }

    function getLineContent(line) {
        const ln = line.querySelector('.ln')

        return ln ? ln.textContent : ''
    }

    function getHunkContent(hunkIndex, container) {
        const lines = []
        container.querySelectorAll(`.clickable-hunk[data-hunk="${hunkIndex}"]`).forEach((el) => {
            lines.push(getLineContent(el))
        })

        // Trim leading and trailing empty lines
        let start = 0, end = lines.length

        while (start < end && lines[start] === '') {
            start++
        }

        while (end > start && lines[end - 1] === '') {
            end--
        }

        return lines.slice(start, end).join('\n')
    }

    diffContainer.addEventListener('contextmenu', (event) => {
        if (!(event.target instanceof Element)) {
            return
        }

        const line = event.target.closest('.line')

        if (!line) {
            return
        }

        event.preventDefault()

        if (line.classList.contains('diff-empty')) {
            return
        }

        ctxTarget = line

        const isHunk = line.matches('.clickable-hunk')
        const lineNum = line.getAttribute('data-line')
        const copyLineBtn = ctxMenu.querySelector('[data-action="copy-line"]')
        copyLineBtn.textContent = lineNum ? `Copy line (${lineNum})` : 'Copy line'

        const hunkBtn = ctxMenu.querySelector('[data-action="copy-hunk"]')

        if (isHunk) {
            const hunkIdx = line.getAttribute('data-hunk')
            const container = line.closest('.code-lines')
            const hunkLines = container.querySelectorAll(`.clickable-hunk[data-hunk="${hunkIdx}"]`)
            let min = Infinity, max = -Infinity

            hunkLines.forEach((el) => {
                const ln = parseInt(el.getAttribute('data-line'))

                if (!isNaN(ln)) {
                    min = Math.min(min, ln)
                    max = Math.max(max, ln)
                }
            })

            hunkBtn.textContent = min !== Infinity ? `Copy hunk (${min}~${max})` : 'Copy hunk'
            hunkBtn.style.display = ''
        } else {
            hunkBtn.style.display = 'none'
        }

        ctxMenu.style.display = 'block'

        const scale = zoom / 100
        const menuWidth = ctxMenu.offsetWidth / scale
        const menuHeight = ctxMenu.offsetHeight / scale
        const viewW = window.innerWidth / scale
        const viewH = window.innerHeight / scale

        ctxMenu.style.left = Math.min(event.clientX / scale, viewW - menuWidth - 4) + 'px'
        ctxMenu.style.top = Math.min(event.clientY / scale, viewH - menuHeight - 4) + 'px'
    })

    ctxMenu.addEventListener('click', (event) => {
        const btn = event.target.closest('.ctx-item')

        if (!btn || !ctxTarget) {
            return
        }

        const action = btn.dataset.action

        if (action === 'copy-line') {
            const content = getLineContent(ctxTarget)
            navigator.clipboard.writeText(content).catch(() => {})
        } else if (action === 'copy-hunk') {
            if (ctxTarget.matches('.clickable-hunk')) {
                const container = ctxTarget.closest('.code-lines')
                const content = getHunkContent(ctxTarget.dataset.hunk, container)
                navigator.clipboard.writeText(content).catch(() => {})
            }
        }

        hideContextMenu()
    })

    document.addEventListener('pointerdown', (event) => {
        if (ctxMenu.style.display === 'block' && !ctxMenu.contains(event.target)) {
            hideContextMenu()
        }
    })

    // Let extension know we're ready
    webviewReady = true
    vscode.postMessage({type: 'ready', mode: requestedUnified ? 'unified' : 'side-by-side'})
    diffContainer.focus()
})()
