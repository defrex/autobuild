declare module 's3rver' {
  export default class S3rver {
    constructor(options: {
      address: string
      port: number
      silent: boolean
      directory: string
      configureBuckets: { name: string }[]
    })
    run(): Promise<{ port: number }>
    close(): Promise<void>
  }
}
