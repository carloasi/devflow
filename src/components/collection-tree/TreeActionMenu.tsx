'use client'

import {
  Download,
  Edit2,
  FilePlus2,
  FileText,
  Folder,
  Gauge,
  GitBranch,
  Link,
  MoreHorizontal,
  Play,
  Plus,
  Star,
  Terminal,
  Trash2,
  X,
  Radio, RefreshCw } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { CollectionItem } from '@/app/types/CollectionItem'
import { useState } from 'react'

interface Props {
  item: CollectionItem
  onRename: () => void
  onDelete: () => void
  onDuplicate: () => void
  onAddRequest: () => void
  onAddGrpcRequest?: () => void
  onAddFolder: () => void
  onImportCurl?: () => void
  onExport?: () => void
  onRun?: () => void
  onLoadTest?: () => void
  // Envia só esta collection pro GitHub. Só vem preenchido na raiz: é a
  // granularidade em que o remoto guarda um arquivo por collection.
  onPushCollection?: () => void
  // Baixa o que mudou no GitHub só desta collection, abrindo a tela de
  // comparação para escolher o que aceitar.
  onPullCollection?: () => void
  // Só responde "tem algo novo?" — sem abrir a tela de revisão.
  onCheckUpdates?: () => void
  onAddExample?: () => void
  onToggleStar?: () => void
  onCopyUrl?: () => void
  onCopyCurl?: () => void
  // Collection (raiz) -> "Export Collection"; subpasta/request -> "Export".
  isRoot?: boolean
}

export function TreeActionMenu({
  item,
  onRename,
  onDelete,
  onDuplicate,
  onAddFolder,
  onAddRequest,
  onAddGrpcRequest,
  onImportCurl,
  onExport,
  onRun,
  onLoadTest,
  onPushCollection,
  onPullCollection,
  onCheckUpdates,
  onAddExample,
  onToggleStar,
  onCopyUrl,
  onCopyCurl,
  isRoot,
}: Props) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const itemClass = `
  relative

  flex
  items-center
  gap-2.5

  rounded-lg

  px-3
  py-2

  text-[13px]
  font-medium

  cursor-pointer
  select-none

  outline-none
  border-none
  ring-0

  transition-all
  duration-150

  hover:bg-pm-hover
  focus:bg-pm-hover

  data-[highlighted]:bg-pm-hover
  data-[highlighted]:text-pm-text
`

  return (
    <>
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) setConfirmingDelete(false)
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation()
          }}
          className="
            h-6
            w-6
            flex
            items-center
            justify-center
            rounded-md
            text-pm-text-muted
            hover:text-pm-text
           
            transition-all
            duration-150
          "
        >
          <MoreHorizontal size={14} />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
  sideOffset={8}
  className="
    z-50
    min-w-[220px]

    overflow-hidden

    rounded-xl

    border
    border-pm-border

    bg-pm-surface

    backdrop-blur-2xl

    p-1.5

    text-pm-text-secondary

    shadow-[0_12px_40px_rgba(0,0,0,0.55)]

    outline-none
    ring-0

    data-[state=open]:animate-in
    data-[state=closed]:animate-out

    data-[state=open]:fade-in-0
    data-[state=closed]:fade-out-0

    data-[state=open]:zoom-in-95
    data-[state=closed]:zoom-out-95

    duration-100
  "
>
        {/* Favoritar vale pra qualquer tipo de item. */}
        {onToggleStar && (
          <DropdownMenuItem
            onClick={onToggleStar}
            className={itemClass}
          >
            <Star
              size={14}
              className={item.starred ? 'text-amber-400 fill-amber-400' : 'text-pm-text-muted group-hover:text-pm-text'}
            />

            {item.starred ? 'Remove from Favorites' : 'Add to Favorites'}
          </DropdownMenuItem>
        )}

        {item.type === 'folder' && (
          <>
            {onPushCollection && (
              <DropdownMenuItem onClick={onPushCollection} className={itemClass}>
                <GitBranch size={14} className="text-pm-text-muted group-hover:text-pm-text" />
                Push to GitHub
              </DropdownMenuItem>
            )}

            {onPullCollection && (
              <DropdownMenuItem onClick={onPullCollection} className={itemClass}>
                <Download size={14} className="text-pm-text-muted group-hover:text-pm-text" />
                Pull from GitHub
              </DropdownMenuItem>
            )}

            {onCheckUpdates && (
              <DropdownMenuItem onClick={onCheckUpdates} className={itemClass}>
                <RefreshCw size={14} className="text-pm-text-muted group-hover:text-pm-text" />
                Check for updates
              </DropdownMenuItem>
            )}

            {onRun && (
              <DropdownMenuItem
                onClick={onRun}
                className={itemClass}
              >
                <Play
                  size={14}
                  className="text-pm-text-muted group-hover:text-pm-text"
                />

                Run
              </DropdownMenuItem>
            )}

            {onLoadTest && (
              <DropdownMenuItem
                onClick={onLoadTest}
                className={itemClass}
              >
                <Gauge
                  size={14}
                  className="text-pm-text-muted group-hover:text-pm-text"
                />

                Load Test
              </DropdownMenuItem>
            )}

            <DropdownMenuItem
              onClick={onAddRequest}
              className={itemClass}
            >
              <Plus
                size={14}
                className="text-pm-text-muted group-hover:text-pm-text"
              />

              Add Request
            </DropdownMenuItem>

            {onAddGrpcRequest && (
              <DropdownMenuItem
                onClick={onAddGrpcRequest}
                className={itemClass}
              >
                <Radio
                  size={14}
                  className="text-pm-text-muted group-hover:text-pm-text"
                />

                Add gRPC Request
              </DropdownMenuItem>
            )}

            <DropdownMenuItem
              onClick={onAddFolder}
              className={itemClass}
            >
              <Folder
                size={14}
                className="text-pm-text-muted group-hover:text-pm-text"
              />

              Add Folder
            </DropdownMenuItem>

             {onImportCurl && (
              <DropdownMenuItem onClick={onImportCurl} className={itemClass}>
                <Terminal size={14} className="text-pm-text-muted group-hover:text-pm-text" />
                Import cURL
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator className="bg-pm-border my-1" />
          </>
        )}

        {item.type === 'request' && (onLoadTest || onAddExample || onCopyUrl || onCopyCurl) && (
          <>
            {onCopyUrl && (
              <DropdownMenuItem onClick={onCopyUrl} className={itemClass}>
                <Link size={14} className="text-pm-text-muted group-hover:text-pm-text" />
                Copy URL
              </DropdownMenuItem>
            )}

            {onCopyCurl && (
              <DropdownMenuItem onClick={onCopyCurl} className={itemClass}>
                <Terminal size={14} className="text-pm-text-muted group-hover:text-pm-text" />
                Copy as cURL
              </DropdownMenuItem>
            )}

            {onLoadTest && (
              <DropdownMenuItem
                onClick={onLoadTest}
                className={itemClass}
              >
                <Gauge
                  size={14}
                  className="text-pm-text-muted group-hover:text-pm-text"
                />

                Load Test
              </DropdownMenuItem>
            )}

            {onAddExample && (
              <DropdownMenuItem
                onClick={onAddExample}
                className={itemClass}
              >
                <FilePlus2
                  size={14}
                  className="text-pm-text-muted group-hover:text-pm-text"
                />

                Add Example
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator className="bg-pm-border my-1" />
          </>
        )}

        <DropdownMenuItem
          onClick={onRename}
          className={itemClass}
        >
          <Edit2
            size={14}
            className="text-pm-text-muted group-hover:text-pm-text"
          />

          Rename
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={onDuplicate}
          className={itemClass}
        >
          <FileText
            size={14}
            className="text-pm-text-muted group-hover:text-pm-text"
          />

          Duplicate
        </DropdownMenuItem>

        {onExport && (
          <DropdownMenuItem
            onClick={onExport}
            className={itemClass}
          >
            <Download
              size={14}
              className="text-pm-text-muted group-hover:text-pm-text"
            />

            {isRoot ? 'Export Collection' : 'Export'}
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator className="bg-pm-border my-1" />

        {confirmingDelete ? (
  <>
    {/* Cancelar vem primeiro para ser a opção focada por padrão */}
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault()
        setConfirmingDelete(false)
      }}
      className={`${itemClass} font-medium text-muted-foreground hover:text-foreground`}
    >
      <X size={14} className="mr-2" />
      Cancel
    </DropdownMenuItem>

    {/* Ação destrutiva destacada */}
    <DropdownMenuItem
      onSelect={(e) => {
        e.preventDefault()
        onDelete()
        setConfirmingDelete(false)
      }}
      className={`${itemClass} font-semibold  text-red-500 hover:bg-red-500 hover:text-white data-[highlighted]:bg-red-500 data-[highlighted]:text-white transition-colors`}
    >
      <Trash2 size={14} className="mr-2 shrink-0" />
      Confirm deletion
    </DropdownMenuItem>
  </>
) : (
  <DropdownMenuItem
    onSelect={(e) => {
      e.preventDefault()
      setConfirmingDelete(true)
    }}
    className={`${itemClass} text-red-500 hover:bg-red-500/10 data-[highlighted]:bg-red-500/10 data-[highlighted]:text-red-600`}
  >
    <Trash2 size={14} className="mr-2 shrink-0" />
    Delete
  </DropdownMenuItem>
)}

      </DropdownMenuContent>
    </DropdownMenu>

    </>
    
  )
}