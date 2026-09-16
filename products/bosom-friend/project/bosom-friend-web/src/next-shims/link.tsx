import { forwardRef } from 'react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { Link as RouterLink } from 'react-router-dom'

interface NextLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string
  children?: ReactNode
  replace?: boolean
  scroll?: boolean
  prefetch?: boolean
  legacyBehavior?: boolean
}

const Link = forwardRef<HTMLAnchorElement, NextLinkProps>(function Link(
  { href, children, replace, ...rest },
  ref,
) {
  if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) {
    return (
      <a href={href} ref={ref} {...rest}>
        {children}
      </a>
    )
  }
  // 桌面端路由无语言前缀：把 /zh-CN/xxx 归一化为 /xxx
  const desktopHref = href.replace(/^\/(zh-CN|en|ja)\//, '/').replace(/^\/(zh-CN|en|ja)$/, '/')
  return (
    <RouterLink to={desktopHref} replace={replace} ref={ref} {...rest}>
      {children}
    </RouterLink>
  )
})

export default Link
