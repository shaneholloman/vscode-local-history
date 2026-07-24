export function createTimelineController(app) {
    const {dom, state} = app

    function revealActivePoint(activeIndex) {
        const point = dom.timelineStrip.querySelector(`.timeline-point[data-index="${activeIndex}"]`)
        point?.scrollIntoView({block: 'nearest', inline: 'nearest'})
    }

    function buildTimelineBars(dates, activeIndex) {
        const existingPoints = dom.timelineStrip.querySelectorAll('.timeline-point')

        if (existingPoints.length === dates.length) {
            existingPoints.forEach((point) => {
                point.classList.toggle('active', Number(point.dataset.index) === activeIndex)
            })
            revealActivePoint(activeIndex)

            return
        }

        const track = document.createElement('div')
        track.className = 'timeline-track'
        dom.timelineStrip.innerHTML = ''

        for (let index = dates.length - 1; index >= 0; index--) {
            const point = document.createElement('button')
            point.className = 'timeline-point' + (index === activeIndex ? ' active' : '')
            point.type = 'button'
            point.dataset.index = String(index)
            point.setAttribute('aria-label', `Snapshot ${dates[index]}`)

            const dot = document.createElement('span')
            dot.className = 'timeline-dot'

            const date = document.createElement('span')
            date.className = 'timeline-date'
            date.textContent = dates[index]
            point.append(dot, date)
            point.addEventListener('click', () => {
                if (index === state.currentSnapshotIndex) {
                    return
                }

                state.currentSnapshotIndex = index
                app.showDiffLoading()
                app.vscode.postMessage({type: 'goto', index})
            })
            track.appendChild(point)
        }

        const rail = document.createElement('div')
        rail.className = 'timeline-rail'
        track.appendChild(rail)
        dom.timelineStrip.appendChild(track)
        revealActivePoint(activeIndex)
    }

    function updateNavigation(message) {
        state.currentSnapshotIndex = message.snapshotIndex
        state.totalSnapshotCount = message.totalCount
        state.snapshotDates = message.snapshotDates
        dom.counter.textContent = message.currentIndex + ' / ' + message.totalCount
        dom.prevBtn.disabled = !message.hasPrev
        dom.nextBtn.disabled = !message.hasNext
        buildTimelineBars(message.snapshotDates, message.snapshotIndex)
    }

    function previewNavigation(direction) {
        const nextIndex = state.currentSnapshotIndex + (direction === 'prev' ? 1 : -1)

        if (nextIndex < 0 || nextIndex >= state.totalSnapshotCount) {
            return false
        }

        updateNavigation({
            currentIndex  : state.totalSnapshotCount - nextIndex,
            totalCount    : state.totalSnapshotCount,
            hasPrev       : nextIndex < state.totalSnapshotCount - 1,
            hasNext       : nextIndex > 0,
            snapshotDates : state.snapshotDates,
            snapshotIndex : nextIndex,
        })

        return true
    }

    function bind() {
        dom.timelineStrip.addEventListener('wheel', (event) => {
            if (event.deltaY === 0) {
                return
            }

            event.preventDefault()
            dom.timelineStrip.scrollLeft -= event.deltaY
        }, {passive: false})
    }

    return {bind, previewNavigation, updateNavigation}
}
