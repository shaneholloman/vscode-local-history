export function createScrollController(app) {
    const {dom, state} = app
    let syncing = false
    let smoothScrollSource = null
    let smoothScrollTarget = 0
    let scrollAnimationFrame = 0

    function getScrollPane() {
        if (state.unified) {
            return dom.unifiedPane
        }

        return dom.diffContainer.classList.contains('same-content')
            ? dom.rightPaneBody
            : dom.leftPaneBody
    }

    function captureScrollPosition() {
        return {
            leftTop     : dom.leftPaneBody.scrollTop,
            leftLeft    : dom.leftPaneBody.scrollLeft,
            rightTop    : dom.rightPaneBody.scrollTop,
            rightLeft   : dom.rightPaneBody.scrollLeft,
            unifiedTop  : dom.unifiedPane.scrollTop,
            unifiedLeft : dom.unifiedPane.scrollLeft,
        }
    }

    function captureVisibleLine() {
        const activePane = state.unified ? dom.unifiedPane : dom.leftPaneBody
        const container = state.unified ? dom.unifiedLines : dom.leftLines
        const paneTop = activePane.getBoundingClientRect().top

        for (const line of container.querySelectorAll('.line[data-line]')) {
            if (line.classList.contains('unchanged-region')
                || line.closest('.region-block:not(.expanded)')) {
                continue
            }

            const rect = line.getBoundingClientRect()

            if (rect.height > 0 && rect.bottom > paneTop) {
                return {
                    line      : parseInt(line.getAttribute('data-line')),
                    topOffset : rect.top - paneTop,
                }
            }
        }

        return null
    }

    function findClosestLine(container, lineNum) {
        const exactLine = container.querySelector(`.line[data-line="${lineNum}"]`)

        if (exactLine) {
            return exactLine
        }

        let closestLine = null
        let closestDistance = Infinity

        for (const line of container.querySelectorAll('.line[data-line]')) {
            const distance = Math.abs(parseInt(line.getAttribute('data-line')) - lineNum)

            if (distance < closestDistance) {
                closestDistance = distance
                closestLine = line
            }
        }

        return closestLine
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
            animateScroll(pane, atTop ? pane.scrollHeight - pane.clientHeight : 0)
        }
    }

    function updateScrollButton() {
        const pane = getScrollPane()

        if (pane.scrollHeight <= pane.clientHeight) {
            dom.scrollTopBtn.classList.add('hidden')

            return
        }

        dom.scrollTopBtn.classList.remove('hidden')
        const atTop = pane.scrollTop <= 0
        dom.scrollTopBtn.classList.toggle('scroll-bottom', atTop)
        dom.scrollTopBtn.dataset.tooltip = atTop ? 'Scroll to bottom' : 'Scroll to top'
        dom.scrollTopBtn.setAttribute('aria-label', dom.scrollTopBtn.dataset.tooltip)
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

    function bind() {
        dom.leftPaneBody.addEventListener('scroll', () => {
            syncPanes(dom.leftPaneBody, dom.rightPaneBody)
            updateScrollButton()
        }, {passive: true})
        dom.rightPaneBody.addEventListener('scroll', () => {
            syncPanes(dom.rightPaneBody, dom.leftPaneBody)
            updateScrollButton()
        }, {passive: true})
        dom.unifiedPane.addEventListener('scroll', updateScrollButton, {passive: true})
    }

    return {
        animateScroll,
        bind,
        captureScrollPosition,
        captureVisibleLine,
        findClosestLine,
        getScrollPane,
        scrollToTopBottom,
        updateScrollButton,
    }
}
