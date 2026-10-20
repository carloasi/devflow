'use client'

import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'

interface Props {
  activeTab: {
    method: string
  }
  updateActiveTab: (data: { method: string }) => void
}

type MethodConfig = {
  label: string
  color: string
  bgActive: string
  bgHover: string
  description: string
}

const METHODS_CONFIG: Record<string, MethodConfig> = {
  GET: {
    label: 'GET',
    color: 'text-green-500',
    bgActive: 'bg-green-500/10 text-green-500',
    bgHover: 'hover:bg-green-500/5',
    description: '',
  },
  POST: {
    label: 'POST',
    color: 'text-orange-500',
    bgActive: 'bg-orange-500/10 text-orange-500',
    bgHover: 'hover:bg-orange-500/5',
    description: '',
  },
  PUT: {
    label: 'PUT',
    color: 'text-sky-400',
    bgActive: 'bg-sky-400/10 text-sky-400',
    bgHover: 'hover:bg-sky-400/5',
    description: '',
  },
  PATCH: {
    label: 'PATCH',
    color: 'text-gray-400',
    bgActive: 'bg-gray-400/10 text-gray-400',
    bgHover: 'hover:bg-gray-400/5',
    description: '',
  },
  DELETE: {
    label: 'DELETE',
    color: 'text-red-500',
    bgActive: 'bg-red-500/10 text-red-500',
    bgHover: 'hover:bg-red-500/5',
    description: '',
  },
}
export function MethodDropdown({ activeTab, updateActiveTab }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const currentMethod = (activeTab.method?.toUpperCase() || 'GET') as keyof typeof METHODS_CONFIG
  const currentStyle = METHODS_CONFIG[currentMethod] || METHODS_CONFIG.GET

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div ref={dropdownRef} className="relative inline-block text-left select-none">
      {/* GATILHO DO DROPDOWN */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`
          flex items-center justify-between gap-1
          h-8 px-2.5 rounded-bl-lg rounded-tl-lg
          transition-colors duration-150
          outline-none cursor-pointer
          
          w-[84px] shrink-0
          hover:bg-pm-hover
          ${isOpen ? 'bg-pm-hover' : ''}
        `}
      >
        <span className={`text-[11px] font-bold tracking-[0.06em] ${currentStyle.color}`}>
          {currentStyle.label}
        </span>

        <ChevronDown
          size={13}
          className={`text-pm-text-muted transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* POPUP CONTAINER */}
      {isOpen && (
        <div
          className="
            absolute left-0 top-full mt-2 z-[9999]
            w-[220px] rounded-lg p-1.5
            border border-pm-border
            bg-pm-surface backdrop-blur-2xl
            text-pm-text-secondary
            shadow-[0_12px_40px_rgba(0,0,0,0.55)]
            outline-none origin-top-left
            animate-in fade-in-0 zoom-in-95 duration-100
          "
        >
          {/* LISTA DE OPÇÕES */}
          <div className="flex flex-col gap-[2px]">
            {Object.entries(METHODS_CONFIG).map(([key, value]) => {
              const isActive = activeTab.method === key

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    updateActiveTab({ method: key })
                    setIsOpen(false)
                  }}
                  className={`
                    group flex items-center justify-between
                    w-full h-9 px-2.5 rounded-md
                    transition-colors duration-150
                    text-left cursor-pointer
                    ${isActive ? value.bgActive : `text-pm-text-muted ${value.bgHover} hover:text-pm-text`}
                  `}
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    {/* INDICADOR METODO */}
                    <span className={`text-[11px] font-bold tracking-[0.06em] w-[48px] shrink-0 ${value.color}`}>
                      {value.label}
                    </span>

                    {/* TEXTO INFORMATIVO */}
                    <span className="text-[10px] text-pm-text-muted group-hover:text-pm-text-secondary transition-colors truncate">
                      {value.description}
                    </span>
                  </div>

                  {/* ÍCONE DE CHECK */}
                  {isActive && <Check size={13} className={`shrink-0 ${value.color}`} />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

