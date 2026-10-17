import type { RefreshScheduler } from '../cli/dashboard/refresh'

export class FakeRefreshScheduler implements RefreshScheduler {
  current = 0
  next = 0
  tasks = new Map<number, { at: number; callback: () => void }>()
  now = () => this.current
  set(callback: () => void, delay: number): unknown {
    const id = ++this.next
    this.tasks.set(id, { at: this.current + delay, callback })
    return id
  }
  clear(handle: unknown): void {
    this.tasks.delete(handle as number)
  }
  async settle(): Promise<void> {
    for (let i = 0; i < 100; i++) await Promise.resolve()
  }
  async advance(duration: number): Promise<void> {
    const end = this.current + duration
    await this.settle()
    while (true) {
      const entry = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0]
      if (entry === undefined || entry[1].at >= end) break
      this.current = entry[1].at
      this.tasks.delete(entry[0])
      entry[1].callback()
      await this.settle()
    }
    this.current = end
  }
}
