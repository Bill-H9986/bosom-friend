import type { VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import * as React from 'react'

import { cn } from '@web/utils/className'

const buttonVariants = cva('btn', {
  variants: {
    variant: {
      default: 'btn-primary',
      destructive: 'btn-danger',
      outline: 'btn-outline',
      secondary: 'btn-secondary',
      ghost: 'btn-ghost',
      link: 'btn-link',
    },
    size: {
      default: 'btn-md',
      sm: 'btn-sm',
      lg: 'btn-lg',
      xl: 'btn-xl',
      icon: 'btn-icon',
      'icon-sm': 'btn-icon-sm',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
})

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    const isDisabled = props.disabled || loading

    // asChild 模式下，Slot 需要单个子元素，不能渲染 loading spinner
    if (asChild) {
      return (
        <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
      )
    }

    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={isDisabled}
        {...props}
      >
        {loading && (
          <svg className="w-4 h-4 mr-2 animate-spin" viewBox="0 0 24 24" aria-hidden>
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
              strokeOpacity="0.2"
              fill="none"
            />
            <path
              d="M22 12a10 10 0 0 1-10 10"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        )}
        {props.children}
      </Comp>
    )
  },
)
Button.displayName = 'Button'

export { Button, buttonVariants }
