import dynamic from '@web/next-shims/dynamic'
import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'

const AccountPageCore = dynamic(() => import('../app/[lng]/accounts/accountCore'), {
  loading: null,
})

export default function AccountPage() {
  const location = useLocation()
  const searchParams = useMemo(() => {
    const values = new URLSearchParams(location.search)
    const hashQuery = location.hash.includes('?')
      ? location.hash.slice(location.hash.indexOf('?') + 1)
      : ''
    for (const [key, value] of new URLSearchParams(hashQuery)) {
      values.set(key, value)
    }
    return Object.fromEntries(values.entries())
  }, [location.search, location.hash])

  return <AccountPageCore searchParams={searchParams} />
}
