import {dom} from './dom.js'
import {createDiffActionsController} from './diff-actions.js'
import {createRenderController} from './render.js'
import {createScrollController} from './scroll.js'
import {createSearchController} from './search.js'
import {createTimelineController} from './timeline.js'

const vscode = acquireVsCodeApi()
const state = {
    webviewActive       : true,
    diffLoading         : false,
    userChoice          : null,
    unified             : document.body.dataset.initialUnified === 'true',
    requestedUnified    : document.body.dataset.initialUnified === 'true',
    zoom                : 100,
    tooltipTarget       : null,
    metaPressed         : false,
    currentSnapshotIndex: 0,
    totalSnapshotCount  : 0,
    snapshotDates       : [],
    cachedRightHtml     : null,
    webviewReady        : false,
    searchMatches       : [],
    searchCurrentIndex  : -1,
    searchOpen          : false,
    pinnedLines         : new Set(),
    pinActive           : false,
    pendingScrollRestore: null,
    pendingScrollLine   : null,
    pendingUndoAnimation: null,
    lastHunkAction      : null,
}
const app = {dom, state, vscode}
const breakpoint = Number(document.body.dataset.breakpoint)
const sideBySideBlockedMessage = 'Side-by-side mode is not currently available. Disable "diffEditor.useInlineViewWhenSpaceIsLimited" or increase the editor width.'

document.documentElement.style.setProperty('--line-height', document.body.dataset.lineHeight || '1.5em')

function setDiffLoadingVisible(visible) {
    dom.diffContainer.classList.toggle('loading', visible)
    dom.loadingIndicator.classList.toggle('visible', visible)
}

function showDiffLoading() {
    state.diffLoading = true
    setDiffLoadingVisible(state.webviewActive)
}

function hideDiffLoading() {
    state.diffLoading = false
    setDiffLoadingVisible(false)
}

function refresh() {
    vscode.postMessage({type: 'refresh'})
}

function hideTooltip() {
    state.tooltipTarget = null
    dom.hoverTooltip.classList.remove('visible')
}

function positionTooltip(x, y) {
    const scale = state.zoom / 100
    const viewportWidth = window.innerWidth / scale
    const viewportHeight = window.innerHeight / scale
    const tooltipRect = dom.hoverTooltip.getBoundingClientRect()
    const tooltipWidth = tooltipRect.width / scale
    const tooltipHeight = tooltipRect.height / scale
    const left = Math.min((x + 12) / scale, viewportWidth - tooltipWidth - 8 / scale)
    const below = (y + 18) / scale
    const above = (y - 8) / scale - tooltipHeight
    const top = below + tooltipHeight <= viewportHeight - 8 / scale ? below : above

    dom.hoverTooltip.style.left = Math.max(8 / scale, left) + 'px'
    dom.hoverTooltip.style.top = Math.max(8 / scale, top) + 'px'
}

function getTooltipText(target) {
    let text = target.dataset.tooltip

    if (state.metaPressed && target.closest('.clickable-hunk')) {
        const lineNum = target.dataset.line
        text = text.replace('this change', lineNum ? `this line (line ${lineNum})` : 'this line')
    }

    return text
}

function showTooltip(target, x, y, event) {
    state.tooltipTarget = target

    if (event) {
        state.metaPressed = event.metaKey || event.ctrlKey
    }

    dom.hoverTooltip.textContent = getTooltipText(target)
    dom.hoverTooltip.classList.add('visible')
    const targetRect = target.getBoundingClientRect()
    positionTooltip(x ?? targetRect.left, y ?? targetRect.top)
}

function refreshTooltipText() {
    if (state.tooltipTarget && dom.hoverTooltip.classList.contains('visible')) {
        dom.hoverTooltip.textContent = getTooltipText(state.tooltipTarget)
    }
}

function updateRegionLabels(regionId, label, onlyButton = null) {
    const buttons = onlyButton
        ? [onlyButton]
        : document.querySelectorAll(`.clickable-region[data-region="${regionId}"]`)
    buttons.forEach((button) => {
        button.dataset.tooltip = label
        button.setAttribute('aria-label', label)
    })
    document.querySelectorAll(`.hidden-label[data-region-label="${regionId}"]`).forEach((labelElement) => {
        labelElement.textContent = label
    })
}

function updatePinButton() {
    if (state.pinnedLines.size > 0) {
        dom.clearPinBtn.style.display = ''
        dom.pinBtn.style.display = ''
        dom.pinBtn.dataset.tooltip = state.pinActive
            ? 'Clear pin filter'
            : `Show only ${state.pinnedLines.size} pinned line${state.pinnedLines.size > 1 ? 's' : ''}`
        dom.pinBtn.classList.toggle('active', state.pinActive)
    } else {
        dom.clearPinBtn.style.display = 'none'
        dom.pinBtn.style.display = 'none'
        dom.pinBtn.classList.remove('active')

        if (state.pinActive) {
            state.pinActive = false
            applyPinFilter()
        }
    }
}

function applyPinFilter() {
    if (!state.pinActive || state.pinnedLines.size === 0) {
        document.querySelectorAll('.line-hidden').forEach((element) => element.classList.remove('line-hidden'))

        return
    }

    const contextLines = parseInt(document.body.dataset.contextLines || '3')
    const visibleLines = new Set()

    for (const pinnedLine of state.pinnedLines) {
        visibleLines.add(pinnedLine)

        for (let offset = 1; offset <= contextLines; offset++) {
            visibleLines.add(pinnedLine - offset)
            visibleLines.add(pinnedLine + offset)
        }
    }

    const containers = state.unified ? [dom.unifiedLines] : [dom.leftLines, dom.rightLines]

    for (const container of containers) {
        for (const line of container.querySelectorAll('.line[data-line]')) {
            line.classList.toggle('line-hidden', !visibleLines.has(parseInt(line.dataset.line)))
        }
    }
}

function togglePinLine(lineNumber) {
    const refreshView = state.pinActive

    if (refreshView) {
        state.pendingScrollRestore = scroll.captureScrollPosition()
    }

    if (state.pinnedLines.has(lineNumber)) {
        state.pinnedLines.delete(lineNumber)
        document.querySelectorAll(`.line[data-line="${lineNumber}"]`).forEach((line) => line.classList.remove('pinned'))
    } else {
        state.pinnedLines.add(lineNumber)
        document.querySelectorAll(`.line[data-line="${lineNumber}"]`).forEach((line) => line.classList.add('pinned'))
    }

    updatePinButton()

    if (state.pinActive) {
        applyPinFilter()
    }

    if (refreshView) {
        showDiffLoading()
        refresh()
    }
}

function restorePinState() {
    if (state.pinnedLines.size === 0) {
        return
    }

    const containers = state.unified ? [dom.unifiedLines] : [dom.leftLines, dom.rightLines]
    const expandedRegions = new Set()

    for (const container of containers) {
        for (const pinnedLine of state.pinnedLines) {
            container.querySelectorAll(`.line[data-line="${pinnedLine}"]`).forEach((line) => {
                line.classList.add('pinned')
                const region = line.closest('.region-block')

                if (region) {
                    region.classList.add('expanded')
                    region.style.height = ''
                    expandedRegions.add(region.dataset.region)
                }
            })
        }
    }

    expandedRegions.forEach((regionId) => {
        const count = document.querySelector(`.unchanged-region[data-region="${regionId}"]`)?.dataset.count || '?'
        updateRegionLabels(regionId, 'Hide ' + count + ' unchanged lines')
    })
    updatePinButton()

    if (state.pinActive) {
        applyPinFilter()
    }
}

function notifySideBySideBlocked() {
    vscode.postMessage({type: 'show-notification', message: sideBySideBlockedMessage})
}

function applyZoom() {
    document.body.style.zoom = state.zoom + '%'
    dom.zoomResetBtn.textContent = state.zoom + '%'
    hideTooltip()
    requestAnimationFrame(render.syncDiffLineHeights)
}

function changeZoom(amount) {
    state.zoom = Math.max(50, Math.min(200, state.zoom + amount))
    applyZoom()
}

function setZoom(zoomValue) {
    state.zoom = zoomValue
    applyZoom()
}

function setViewMode(showUnified) {
    state.unified = showUnified
    dom.diffContainer.classList.toggle('unified-mode', state.unified)
    dom.viewToggle.textContent = state.unified ? 'Side-by-side' : 'Unified'
    dom.viewToggle.dataset.tooltip = state.unified ? 'Switch to side-by-side mode' : 'Switch to unified mode'
}

function requestViewMode(showUnified) {
    if (state.requestedUnified === showUnified && state.diffLoading) {
        return
    }

    state.requestedUnified = showUnified
    showDiffLoading()
    vscode.postMessage({type: 'render-mode', mode: showUnified ? 'unified' : 'side-by-side'})
}

function applyView() {
    let showUnified

    if (window.innerWidth < breakpoint) {
        showUnified = true
    } else if (state.userChoice !== null) {
        showUnified = state.userChoice
    } else {
        showUnified = document.body.dataset.initialUnified === 'true'
    }

    if (!state.webviewReady) {
        state.requestedUnified = showUnified
        setViewMode(showUnified)
    } else if (showUnified !== state.unified || showUnified !== state.requestedUnified) {
        state.pendingScrollLine = scroll.captureVisibleLine()
        requestViewMode(showUnified)

        return
    } else {
        setViewMode(showUnified)
        scroll.updateScrollButton()

        return
    }

    scroll.updateScrollButton()
    requestAnimationFrame(render.syncDiffLineHeights)
}

function toggleViewMode() {
    if (window.innerWidth < breakpoint && state.unified) {
        notifySideBySideBlocked()

        return
    }

    state.userChoice = !state.unified
    applyView()
}

function navigate(direction, keyboard = false) {
    if (!timeline.previewNavigation(direction)) {
        return
    }

    showDiffLoading()
    const message = {type: 'navigate', direction}

    if (keyboard) {
        message.keyboard = true
    }

    vscode.postMessage(message)
}

function bindTooltipEvents() {
    const getTooltipTarget = (event) => event?.target instanceof Element
        ? event.target.closest('[data-tooltip]')
        : null

    document.addEventListener('pointerover', (event) => {
        const target = getTooltipTarget(event)

        if (target) {
            showTooltip(target, event.clientX, event.clientY, event)
        }
    })
    document.addEventListener('pointermove', (event) => {
        const target = getTooltipTarget(event)

        if (target !== state.tooltipTarget) {
            target ? showTooltip(target, event.clientX, event.clientY, event) : hideTooltip()
        } else if (target) {
            positionTooltip(event.clientX, event.clientY)
        }
    })

    const hideTooltipOnLeave = (event) => {
        const relatedTarget = event.relatedTarget

        if (!state.tooltipTarget || (relatedTarget instanceof Node && state.tooltipTarget.contains(relatedTarget))) {
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
    document.addEventListener('keydown', (event) => {
        const newState = event.metaKey || event.ctrlKey

        if (newState !== state.metaPressed) {
            state.metaPressed = newState
            refreshTooltipText()
        }
    })
    document.addEventListener('keyup', (event) => {
        const newState = event.metaKey || event.ctrlKey

        if (newState !== state.metaPressed) {
            state.metaPressed = newState
            refreshTooltipText()
        }
    })
    window.addEventListener('blur', () => {
        if (state.metaPressed) {
            state.metaPressed = false
            refreshTooltipText()
        }
    })
    window.addEventListener('scroll', hideTooltip, true)
}

const scroll = createScrollController(app)
app.scroll = scroll
app.showDiffLoading = showDiffLoading
app.refresh = refresh
app.updateRegionLabels = updateRegionLabels
app.togglePinLine = togglePinLine

const timeline = createTimelineController(app)
const search = createSearchController(app)
const diffActions = createDiffActionsController(app)
const render = createRenderController(app)

app.diffActions = diffActions
app.hideDiffLoading = hideDiffLoading
app.restorePinState = restorePinState
app.search = search
app.setViewMode = setViewMode
app.syncDiffLineHeights = render.syncDiffLineHeights
app.timeline = timeline

function bindControls() {
    dom.zoomOutBtn.addEventListener('click', () => changeZoom(-10))
    dom.zoomResetBtn.addEventListener('click', () => setZoom(100))
    dom.zoomInBtn.addEventListener('click', () => changeZoom(10))
    dom.viewToggle.addEventListener('click', toggleViewMode)
    dom.prevBtn.addEventListener('click', () => navigate('prev'))
    dom.nextBtn.addEventListener('click', () => navigate('next'))
    dom.restoreBtn.addEventListener('click', () => vscode.postMessage({type: 'restore'}))
    dom.unifiedRestoreBtn.addEventListener('click', () => vscode.postMessage({type: 'restore'}))
    dom.openFileBtn.addEventListener('click', () => vscode.postMessage({type: 'open-snapshot'}))
    dom.unifiedOpenFileBtn.addEventListener('click', () => vscode.postMessage({type: 'open-snapshot'}))
    dom.undoBtn.addEventListener('click', diffActions.undo)
    dom.scrollTopBtn.addEventListener('click', () => scroll.scrollToTopBottom())
    dom.closeBtn.addEventListener('click', () => vscode.postMessage({type: 'close'}))
    dom.clearPinBtn.addEventListener('click', () => {
        state.pinnedLines.clear()
        state.pinActive = false
        document.querySelectorAll('.pinned, .line-hidden').forEach((element) => element.classList.remove('pinned', 'line-hidden'))
        updatePinButton()
    })
    dom.pinBtn.addEventListener('click', () => {
        state.pendingScrollRestore = scroll.captureScrollPosition()
        state.pinActive = !state.pinActive
        updatePinButton()
        applyPinFilter()
        showDiffLoading()
        refresh()
    })
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault()
            toggleViewMode()
        } else if (event.key === 'ArrowLeft' && document.activeElement !== dom.searchInput) {
            event.preventDefault()
            navigate('prev', true)
        } else if (event.key === 'ArrowRight' && document.activeElement !== dom.searchInput) {
            event.preventDefault()
            navigate('next', true)
        } else if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowDown') {
            event.preventDefault()
            scroll.scrollToTopBottom('bottom')
        } else if ((event.metaKey || event.ctrlKey) && event.key === 'ArrowUp') {
            event.preventDefault()
            scroll.scrollToTopBottom('top')
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            const pane = state.unified ? dom.unifiedPane : dom.leftPaneBody
            pane.scrollBy({top: event.key === 'ArrowUp' ? -40 : 40})
        } else if (event.key === 'Escape') {
            event.preventDefault()

            if (state.searchOpen) {
                search.closeSearch()
            } else if (diffActions.isContextMenuOpen()) {
                diffActions.hideContextMenu()
            } else {
                vscode.postMessage({type: 'close'})
            }
        } else if ((event.metaKey || event.ctrlKey) && (event.key === '=' || event.key === '+')) {
            event.preventDefault()
            changeZoom(10)
        } else if ((event.metaKey || event.ctrlKey) && event.key === '-') {
            event.preventDefault()
            changeZoom(-10)
        } else if ((event.metaKey || event.ctrlKey) && event.key === '0') {
            event.preventDefault()
            setZoom(100)
        } else if ((event.metaKey || event.ctrlKey) && event.key === 'z') {
            event.preventDefault()
            diffActions.undo()
        } else if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
            event.preventDefault()
            search.openSearch()
        }
    })
}

function handleMessage(event) {
    const msg = event.data

    if (msg.type === 'zoom') {
        if (msg.action === 'in') changeZoom(10)
        if (msg.action === 'out') changeZoom(-10)
        if (msg.action === 'reset') setZoom(100)

        return
    }

    if (msg.type === 'viewState') {
        state.webviewActive = msg.active
        document.body.classList.toggle('cloak', !msg.visible)

        if (msg.active) {
            state.pendingScrollRestore = scroll.captureScrollPosition()
            requestAnimationFrame(() => {
                applyView()
                scroll.updateScrollButton()
            })
        }

        return
    }

    if (msg.type === 'action-result') {
        if (!msg.applied) {
            state.lastHunkAction = null
            state.pendingUndoAnimation = null
            diffActions.clearHunkAnimations()
        }

        return
    }

    if (msg.type === 'undo-command') {
        diffActions.undo()

        return
    }

    if (msg.type === 'render') {
        render.handleRenderMessage(msg)
    }
}

app.scroll = scroll
scroll.bind()
timeline.bind()
search.bind()
diffActions.bind()
bindTooltipEvents()
bindControls()

let resizeTimer
window.addEventListener('resize', () => {
    if (window.stripWidth !== document.body.clientWidth) {
        window.stripWidth = document.body.clientWidth
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
            if (state.requestedUnified === state.unified) {
                applyView()
            } else {
                showDiffLoading()
                applyView()
            }
        }, 200)
    }
})
window.addEventListener('message', handleMessage)

applyView()
state.webviewReady = true
vscode.postMessage({type: 'ready', mode: state.requestedUnified ? 'unified' : 'side-by-side'})
dom.diffContainer.focus()
