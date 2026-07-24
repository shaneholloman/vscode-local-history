export function createSearchController(app) {
    const {dom, state} = app

    function clearHighlights() {
        document.querySelectorAll('.highlight-match').forEach((element) => {
            element.classList.remove('highlight-match', 'searched')
        })
        document.querySelectorAll('.line mark').forEach((mark) => {
            mark.replaceWith(...mark.childNodes)
        })
    }

    function updateSearchCounter() {
        dom.searchCounter.textContent = state.searchMatches.length === 0
            ? '0/0'
            : `${state.searchCurrentIndex + 1}/${state.searchMatches.length}`
    }

    function updateRegionLabels(regionId, label) {
        app.updateRegionLabels(regionId, label)
    }

    function highlightTextNode(textNode, escapedQuery) {
        const text = textNode.textContent
        const regex = new RegExp(escapedQuery, 'gi')
        const parts = []
        let lastIndex = 0
        let match

        while ((match = regex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parts.push(document.createTextNode(text.slice(lastIndex, match.index)))
            }

            const mark = document.createElement('mark')
            mark.className = 'highlight-match searched'
            mark.textContent = match[0]
            parts.push(mark)
            lastIndex = match.index + match[0].length
        }

        if (parts.length === 0) {
            return
        }

        if (lastIndex < text.length) {
            parts.push(document.createTextNode(text.slice(lastIndex)))
        }

        const fragment = document.createDocumentFragment()
        parts.forEach((node) => fragment.appendChild(node))
        textNode.parentNode.replaceChild(fragment, textNode)
    }

    function collapseAllRegions() {
        document.querySelectorAll('.region-block.expanded').forEach((block) => {
            const id = block.dataset.region
            block.classList.remove('expanded')
            block.style.height = ''
            const button = document.querySelector(`.clickable-region[data-region="${id}"]`)

            if (button) {
                updateRegionLabels(id, 'Show ' + (button.dataset.count || '?') + ' unchanged lines')
            }
        })
    }

    function performSearch() {
        if (!state.pinActive) {
            collapseAllRegions()
        }

        const query = dom.searchInput.value
        clearHighlights()
        state.searchMatches = []
        state.searchCurrentIndex = -1

        if (!query) {
            updateSearchCounter()

            return
        }

        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp(escapedQuery, 'i')
        const containers = state.unified ? [dom.unifiedLines] : [dom.leftLines, dom.rightLines]

        for (const container of containers) {
            for (const line of container.querySelectorAll('.line[data-line]')) {
                if (line.classList.contains('line-hidden')
                    || line.classList.contains('unchanged-region')
                    || line.closest('.region-block:not(.expanded)')) {
                    continue
                }

                const lineContent = line.querySelector('.ln')

                if (!lineContent || !regex.test(lineContent.textContent)) {
                    continue
                }

                line.classList.add('highlight-match')
                state.searchMatches.push(line)
                const walker = document.createTreeWalker(lineContent, NodeFilter.SHOW_TEXT, null, false)
                const textNodes = []

                while (walker.nextNode()) {
                    textNodes.push(walker.currentNode)
                }

                textNodes.forEach((textNode) => highlightTextNode(textNode, escapedQuery))
            }
        }

        if (state.searchMatches.length > 0) {
            navigateSearch(1)
        }

        updateSearchCounter()
    }

    function navigateSearch(direction) {
        if (state.searchMatches.length === 0) {
            return
        }

        if (state.searchCurrentIndex >= 0) {
            state.searchMatches[state.searchCurrentIndex].classList.remove('searched')
        }

        state.searchCurrentIndex = direction === 1
            ? (state.searchCurrentIndex + 1) % state.searchMatches.length
            : (state.searchCurrentIndex - 1 + state.searchMatches.length) % state.searchMatches.length

        const currentMatch = state.searchMatches[state.searchCurrentIndex]
        currentMatch.classList.add('searched')
        const pane = state.unified ? dom.unifiedPane : dom.leftPaneBody
        const paneRect = pane.getBoundingClientRect()
        const targetRect = currentMatch.getBoundingClientRect()
        const targetScroll = pane.scrollTop + targetRect.top - paneRect.top - pane.clientHeight / 2
        app.scroll.animateScroll(pane, targetScroll)
        updateSearchCounter()
    }

    function openSearch() {
        state.searchOpen = true
        dom.searchArea.classList.add('active')
        dom.searchInput.focus()
        dom.searchInput.select()
    }

    function closeSearch() {
        if (state.pinActive) {
            state.pendingScrollRestore = app.scroll.captureScrollPosition()
            app.showDiffLoading()
            app.refresh()
        }

        state.searchOpen = false
        dom.searchArea.classList.remove('active')
        dom.searchInput.value = ''
        clearHighlights()
        state.searchMatches = []
        state.searchCurrentIndex = -1
        updateSearchCounter()
        dom.diffContainer.focus()
    }

    function bind() {
        let searchDebounce = null

        dom.searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounce)

            if (!dom.searchInput.value) {
                clearHighlights()
                state.searchMatches = []
                state.searchCurrentIndex = -1
                updateSearchCounter()

                return
            }

            searchDebounce = setTimeout(performSearch, 300)
        })
        dom.searchPrevBtn.addEventListener('click', () => navigateSearch(-1))
        dom.searchNextBtn.addEventListener('click', () => navigateSearch(1))
        dom.searchCloseBtn.addEventListener('click', closeSearch)
        dom.searchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault()
                navigateSearch(event.shiftKey ? -1 : 1)
            } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                closeSearch()
            }
        })
    }

    return {bind, closeSearch, openSearch, performSearch}
}
