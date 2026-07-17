export default class Timeout {
    private readonly startTime = Date.now()

    constructor(private readonly duration: number) {}

    public isTimedOut() {
        return this.getDuration() > this.duration
    }

    public logDuration(message = '') {
        console.log(`${message}: ${this.getDuration()}`)
    }

    private getDuration(): number {
        return Date.now() - this.startTime
    }
}
