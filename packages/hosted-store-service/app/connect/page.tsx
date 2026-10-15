import { Connection } from './Connection'
export const dynamic = 'force-dynamic'
export default async function ConnectionPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>
}) {
  const query = await searchParams
  return (
    <Connection
      initialCode={
        typeof query.code === 'string' && /^[A-Fa-f0-9]{10}$/.test(query.code)
          ? query.code.toUpperCase()
          : ''
      }
    />
  )
}
