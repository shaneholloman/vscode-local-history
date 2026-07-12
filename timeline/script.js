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
    const rightPane = document.getElementById('rightPane')
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
    let zoom = 100
    let tooltipTarget = null
    let currentSnapshotIndex = 0
    let totalSnapshotCount = 0
    let snapshotDates = []
    let cachedRightHtml = null
    document.documentElement.style.setProperty('--line-height', document.body.dataset.lineHeight || '1.5em')

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

    function showTooltip(target, x, y) {
        tooltipTarget = target
        hoverTooltip.textContent = target.dataset.tooltip
        hoverTooltip.classList.add('visible')

        const targetRect = target.getBoundingClientRect()
        positionTooltip(x ?? targetRect.left, y ?? targetRect.top)
    }

    function getTooltipTarget(event) {
        return event?.target instanceof Element
            ? event.target.closest('[data-tooltip]')
            : null
    }

    document.addEventListener('pointerover', (event) => {
        const target = getTooltipTarget(event)

        if (target) {
            showTooltip(target, event.clientX, event.clientY)
        }
    })
    document.addEventListener('pointermove', (event) => {
        const target = getTooltipTarget(event)

        if (target !== tooltipTarget) {
            if (target) {
                showTooltip(target, event.clientX, event.clientY)
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

    zoomOutBtn.addEventListener('click', () => changeZoom(-10))
    zoomResetBtn.addEventListener('click', () => setZoom(100))
    zoomInBtn.addEventListener('click', () => changeZoom(10))

    function applyView() {
        let showUnified

        if (window.innerWidth < breakpoint) {
            showUnified = true
        } else if (userChoice !== null) {
            showUnified = userChoice
        } else {
            showUnified = document.body.dataset.initialUnified === 'true'
        }

        unified = showUnified
        diffContainer.classList.toggle('unified-mode', unified)
        viewToggle.textContent = unified ? 'Side-by-side' : 'Unified'
        updateScrollButton()
        requestAnimationFrame(syncDiffLineHeights)
    }

    viewToggle.addEventListener('click', () => {
        userChoice = !unified
        applyView()
    })

    window.addEventListener('resize', applyView)
    window.addEventListener('scroll', hideTooltip, true)
    applyView()

    timelineStrip.addEventListener('wheel', (event) => {
        if (event.deltaY === 0) {
            return
        }

        event.preventDefault()
        timelineStrip.scrollLeft -= event.deltaY
    }, {passive: false})

    prevBtn.addEventListener('click', () => {
        showDiffLoading()
        vscode.postMessage({type: 'navigate', direction: 'prev'})
    })
    nextBtn.addEventListener('click', () => {
        showDiffLoading()
        vscode.postMessage({type: 'navigate', direction: 'next'})
    })
    restoreBtn.addEventListener('click', () => vscode.postMessage({type: 'restore'}))
    unifiedRestoreBtn.addEventListener('click', () => vscode.postMessage({type: 'restore'}))
    undoBtn.addEventListener('click', () => vscode.postMessage({type: 'undo'}))
    scrollTopBtn.addEventListener('click', () => {
        const pane = getScrollPane()
        animateScroll(pane, pane.scrollTop <= 0 ? pane.scrollHeight - pane.clientHeight : 0)
    })

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && window.innerWidth >= breakpoint) {
            e.preventDefault()
            userChoice = !unified
            applyView()
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault()

            if (previewNavigation('prev')) {
                showDiffLoading()
                vscode.postMessage({type: 'navigate', direction: 'prev', keyboard: true})
            }
        } else if (e.key === 'ArrowRight') {
            e.preventDefault()

            if (previewNavigation('next')) {
                showDiffLoading()
                vscode.postMessage({type: 'navigate', direction: 'next', keyboard: true})
            }
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const pane = document.getElementById(unified ? 'unifiedPane' : 'leftPane')
            pane.scrollBy({top: e.key === 'ArrowUp' ? -40 : 40})
        } else if (e.key === 'Escape') {
            e.preventDefault()
            vscode.postMessage({type: 'close'})
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
            vscode.postMessage({type: 'undo'})
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

        for (let i = 0; i < Math.max(leftRows.length, rightRows.length); i++) {
            const leftRow = leftRows[i]
            const rightRow = rightRows[i]

            if (leftRow) {
                leftRow.style.height = ''
            }

            if (rightRow) {
                rightRow.style.height = ''
            }
        }

        for (let i = 0; i < Math.min(leftRows.length, rightRows.length); i++) {
            const height = Math.max(
                leftRows[i].getBoundingClientRect().height,
                rightRows[i].getBoundingClientRect().height,
            )

            leftRows[i].style.height = height + 'px'
            rightRows[i].style.height = height + 'px'
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
            setDiffLoadingVisible(webviewActive && diffLoading)
            document.body.classList.toggle('loading', !msg.active)
            document.body.classList.toggle('reactivating', !msg.active)

            if (msg.active) {
                requestAnimationFrame(() => {
                    applyView()
                    updateScrollButton()
                    document.body.classList.remove('loading', 'reactivating')
                })
            }

            return
        }

        if (msg.type === 'render') {
            leftLines.innerHTML = msg.leftHtml

            if (msg.rightHtml !== cachedRightHtml) {
                rightLines.innerHTML = msg.rightHtml
                cachedRightHtml = msg.rightHtml
            }

            unifiedLines.innerHTML = msg.unifiedHtml
            updateLineNumberGutter()
            updateNavigation(msg)
            diffContainer.classList.toggle('same-content', !msg.hasChanges)
            updateScrollButton()
            restoreBtn.hidden = !msg.hasChanges
            unifiedRestoreBtn.hidden = !msg.hasChanges
            undoBtn.classList.toggle('visible', msg.hasUndo)

            diffContainer.focus()
            hideDiffLoading()
            requestAnimationFrame(() => {
                syncDiffLineHeights()
                document.body.classList.remove('loading')
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
        dates.slice().reverse().forEach((label, visualIndex) => {
            const i = dates.length - visualIndex - 1
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

                showDiffLoading()
                vscode.postMessage({type: 'goto', index: i})
            })
            track.appendChild(point)
        })
        const rail = document.createElement('div')
        rail.className = 'timeline-rail'
        track.appendChild(rail)
        timelineStrip.appendChild(track)
        revealActivePoint(activeIdx)
    }

    function revealActivePoint(activeIdx) {
        timelineStrip.querySelectorAll('.timeline-point').forEach((point) => {
            if (Number(point.dataset.index) === activeIdx) {
                point.scrollIntoView({block: 'nearest', inline: 'nearest'})
            }
        })
    }

    const activatingHunks = new Set()
    const regionAnimations = new Map()
    let syncing = false
    let smoothScrollSource = null
    let smoothScrollTarget = 0
    let scrollAnimationFrame = 0

    function getScrollPane() {
        return unified
            ? unifiedPane
            : diffContainer.classList.contains('same-content') ? rightPane : leftPane
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
        scrollTopBtn.title = atTop ? 'Scroll to bottom' : 'Scroll to top'
        scrollTopBtn.setAttribute('aria-label', scrollTopBtn.title)
    }

    function animateScroll(pane, target) {
        cancelAnimationFrame(scrollAnimationFrame)
        smoothScrollSource = pane
        smoothScrollTarget = target
        const start = pane.scrollTop
        const startedAt = performance.now()

        const step = (timestamp) => {
            const progress = Math.min(1, (timestamp - startedAt) / 180)
            pane.scrollTop = Math.round(start + (target - start) * progress)

            if (progress < 1) {
                scrollAnimationFrame = requestAnimationFrame(step)
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

    leftPane.addEventListener('scroll', () => handlePaneScroll(leftPane, rightPane), {passive: true})
    rightPane.addEventListener('scroll', () => handlePaneScroll(rightPane, leftPane), {passive: true})
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
        vscode.postMessage({
            type  : line.dataset.action === 'add' ? 'apply-hunk' : 'reject-hunk',
            index : parseInt(hunkIndex),
        })
        window.setTimeout(() => {
            activatingHunks.delete(hunkIndex)
            document.querySelectorAll('.clickable-hunk[data-hunk="' + hunkIndex + '"]').forEach((hunkLine) => {
                hunkLine.classList.remove('hunk-changing')
            })
        }, 180)
    }

    function animateRegionLine(line, hide) {
        regionAnimations.get(line)?.cancel()

        if (!hide) {
            line.classList.remove('unchanged-hidden')
        }

        line.style.minHeight = '0px'

        const height = hide ? line.getBoundingClientRect().height : line.scrollHeight
        const animation = line.animate([
            {height: (hide ? height : 0) + 'px', opacity: hide ? 1 : 0},
            {height: (hide ? 0 : height) + 'px', opacity: hide ? 0 : 1},
        ], {duration: 200, easing: 'ease'})

        regionAnimations.set(line, animation)

        animation.onfinish = () => {
            if (regionAnimations.get(line) !== animation) {
                return
            }

            if (hide) {
                line.classList.add('unchanged-hidden')
            }

            line.style.minHeight = ''
            syncDiffLineHeights()
            regionAnimations.delete(line)
        }
    }

    function toggleRegion(toggle) {
        const region = toggle.dataset.region
        const lines = document.querySelectorAll('.line[data-region="' + region + '"]:not(.clickable-region)')
        const hide = lines.length > 0 && !lines[0].classList.contains('unchanged-hidden')
        const label = (hide ? 'Show' : 'Hide') + ' ' + toggle.dataset.count + ' unchanged lines'

        lines.forEach((line) => animateRegionLine(line, hide))
        document.querySelectorAll('.clickable-region[data-region="' + region + '"]').forEach((button) => {
            button.dataset.tooltip = label
            button.setAttribute('aria-label', label)
        })
        document.querySelectorAll('.hidden-label[data-region-label="' + region + '"]').forEach((labelEl) => {
            labelEl.textContent = label
        })
    }

    function activateDiffTarget(target) {
        const hunk = target.closest('.clickable-hunk')
        const region = target.closest('.clickable-region')

        if (hunk) {
            animateAndActivate(hunk)
        } else if (region) {
            toggleRegion(region)
        }
    }

    diffContainer.addEventListener('click', (event) => {
        if (event.target instanceof Element) {
            activateDiffTarget(event.target)
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
        activateDiffTarget(event.target)
    })

    // Let extension know we're ready
    vscode.postMessage({type: 'ready'})
    diffContainer.focus()
})()
