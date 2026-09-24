import { Consent, type ConsentQuery } from './Consent'

export const dynamic = 'force-dynamic'

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<ConsentQuery>
}) {
  return <Consent query={await searchParams} />
}
