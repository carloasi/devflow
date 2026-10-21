'use client'

import React, {
  useRef,
  useState,
} from 'react'

import {
  ChevronsDownUp,
  Plus,
  Upload,
  FileJson,
  Globe2,
  X,
} from 'lucide-react'

import { CollectionTree } from './CollectionTree'
import { CollectionItem } from '@/app/types/CollectionItem'
import { parsePostmanCollection } from '@/utils/postmanParser'
import { parseOpenApi, detectOpenApiVersion } from '@/lib/openapiParser'
import { parsePostmanImport } from '@/components/usePostmanImport'
import { useEnvironment } from '@/components/EnvironmentContext'
import { Environment } from '@/app/types/Environment'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface SidebarProps {
  collections: CollectionItem[]

  // Collections com alteração local ainda não enviada pro GitHub.
  pendingPushIds?: Set<string>

  setCollections: React.Dispatch<
    React.SetStateAction<CollectionItem[]>
  >

  activeId?: string

  onRequestSelect: (item: CollectionItem) => void
  onRenameItem?: (id: string, newName: string) => void
  onRunCollection?: (item: CollectionItem) => void
  onLoadTestItem?: (item: CollectionItem) => void
  onPushCollection?: (item: CollectionItem) => void
  onPullCollection?: (item: CollectionItem) => void
  onAddExampleItem?: (item: CollectionItem) => void
  // Modo "escolher pasta" — usado pelo botão "Convert to Flow" do
  // TabSessionSelector (ver AppLayout.tsx). Enquanto ativo, a árvore
  // inteira vira um seletor de pasta destino: clicar numa pasta chama
  // onPickFolder, itens que não são pasta ficam esmaecidos/desabilitados.
  folderPickMode?: boolean
  pickerLabel?: string
  onPickFolder?: (id: string) => void
  onCancelPicker?: () => void
}

//const STORAGE_KEY = 'postman_clone_collections'

export default function Sidebar({
  collections,
  setCollections,
  activeId,
  onRequestSelect,
  onRenameItem,
  onRunCollection,
  onLoadTestItem,
  onPushCollection,
  onPullCollection,
  onAddExampleItem,
  folderPickMode,
  pickerLabel,
  onPickFolder,
  onCancelPicker,
  pendingPushIds,
}: SidebarProps) {
  const { importEnvironment } = useEnvironment()
  const collectionFileInputRef = useRef<HTMLInputElement>(null)
  const environmentFileInputRef = useRef<HTMLInputElement>(null)
  // Cada incremento fecha todas as pastas da árvore (ver CollectionTree).
  const [collapseAllToken, setCollapseAllToken] = useState(0)

 // const hydrated = useRef(false)

  // useEffect(() => {
  //   try {
  //     const saved =
  //       localStorage.getItem(STORAGE_KEY)

  //     if (saved) {
  //       const parsed: CollectionItem[] =
  //         JSON.parse(saved)

  //       setCollections(parsed)
  //     }
  //   } catch (err) {
  //     console.log(
  //       'Failed to load collections:',
  //       err
  //     )
  //   } finally {
  //     hydrated.current = true
  //   }
  // }, [setCollections])

  /*
   * SAVE
   */
  // useEffect(() => {
  //   if (!hydrated.current) return

  //   try {
  //     localStorage.setItem(
  //       STORAGE_KEY,
  //       JSON.stringify(collections)
  //     )
  //   } catch (err) {
  //     console.log(
  //       'Failed to save collections:',
  //       err
  //     )
  //   }
  // }, [collections])

  /*
   * IMPORT COLLECTION
   */
  const handleImport = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0]

    if (!file) return

    const reader = new FileReader()

    reader.onload = (event) => {
      try {
        const text =
          event.target?.result as string

        // Um arquivo de OpenAPI e uma collection do Postman são ambos .json:
        // quem decide o caminho é o conteúdo, não a extensão nem o usuário.
        const parsed = JSON.parse(text)

        if (detectOpenApiVersion(parsed)) {
          const fallbackName = file.name.replace(/\.(json|ya?ml)$/i, '')
          const result = parseOpenApi(parsed, fallbackName)

          if (!result.collection) {
            alert(result.warnings.join('\n') || 'Could not import this OpenAPI document.')
            return
          }

          setCollections([...collections, result.collection])

          // A URL base entra literal nas requests, pra funcionarem sem
          // configuração nenhuma. Quem quiser trocar de ambiente depois
          // substitui pela variável — e o aviso diz qual é o valor.
          const notes = [...result.warnings]
          if (result.variables.length > 0) {
            notes.unshift(`Base URL: ${result.variables[0].value}`)
          }
          if (notes.length > 0) alert(notes.join('\n'))
          return
        }

        const updatedCollections =
          parsePostmanCollection(
            text,
            file.name,
            collections
          )

        setCollections(updatedCollections)
      } catch (err) {
        console.log(
          'Falha ao importar coleção:',
          err
        )
        alert('Could not read this file. It must be a valid JSON (Postman collection or OpenAPI).')
      }
    }

    reader.readAsText(file)

    e.target.value = ''
  }

  /*
   * IMPORT ENVIRONMENT
   * Aceita os mesmos formatos que o import de collection (Postman Environment
   * Export { name, values }, array de ambientes, ou o wrapper { environments }),
   * via o mesmo parser usado no sync com o GitHub.
   */
  const handleImportEnvironment = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0]

    if (!file) return

    const reader = new FileReader()

    reader.onload = (event) => {
      try {
        const text = event.target?.result as string
        const parsed = JSON.parse(text)
        const result = parsePostmanImport(parsed)

        if (!result.environments || result.environments.length === 0) {
          alert('No environment found in this file.')
          return
        }

        result.environments.forEach(env => {
          const importedEnv: Environment = {
            id: env.id,
            name: env.name,
            values: env.values.map(v => ({
              id: crypto.randomUUID(),
              key: v.key,
              value: v.value,
              type: v.type,
              enabled: v.enabled,
              description: v.description,
            })),
          }
          importEnvironment(importedEnv)
        })
      } catch (err) {
        console.log('Falha ao importar ambiente:', err)
        alert('Could not read the JSON file.')
      } finally {
        e.target.value = ''
      }
    }

    reader.readAsText(file)
  }

  /*
   * CREATE COLLECTION
   */
  const createCollection = () => {
    const newCollection: CollectionItem =
      {
        id: crypto.randomUUID(),
        name: 'New Collection',
        type: 'folder',
        item: [],
      }

    setCollections((prev) => [
      ...prev,
      newCollection,
    ])
  }

  return (
    <div className="h-full flex flex-col bg-pm-sidebar">
      {/* Header */}
      <div
        className="
          h-10
          px-3
          flex
          items-center
          justify-between
          shrink-0
        "
      >
        <span
          className="
            text-[10px]
            font-bold
            uppercase
            tracking-wider
            text-pm-text-muted
          "
        >
          Collections
        </span>

        <div className="flex items-center gap-1">
          {/* Collapse all */}
          <button
            onClick={() => setCollapseAllToken((n) => n + 1)}
            title="Collapse all"
            className="
              h-7
              w-7
              flex
              items-center
              justify-center
              rounded-md
              text-pm-text-muted
              hover:text-pm-text
              hover:bg-pm-hover
              transition-colors
              cursor-pointer
            "
          >
            <ChevronsDownUp size={14} />
          </button>

          {/* Import (Collection ou Environment) */}
          <input
            type="file"
            ref={collectionFileInputRef}
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
          <input
            type="file"
            ref={environmentFileInputRef}
            accept=".json"
            onChange={handleImportEnvironment}
            className="hidden"
          />

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                title="Import"
                className="
                  h-7
                  w-7
                  flex
                  items-center
                  justify-center
                  rounded-md
                  text-pm-text-muted
                  hover:text-pm-text
                  hover:bg-pm-hover
                  transition-colors
                  cursor-pointer
                  outline-none
                "
              >
                <Upload size={14} />
              </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="start" className="w-52 bg-pm-surface border border-pm-border rounded-xl p-1">
              <DropdownMenuItem
                onClick={() => collectionFileInputRef.current?.click()}
                className="rounded-lg text-xs cursor-pointer py-2 px-2.5 gap-2 outline-none focus:bg-pm-hover text-pm-text"
              >
                <FileJson size={13} className="text-pm-text-muted" />
                Import Collection
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => environmentFileInputRef.current?.click()}
                className="rounded-lg text-xs cursor-pointer py-2 px-2.5 gap-2 outline-none focus:bg-pm-hover text-pm-text"
              >
                <Globe2 size={13} className="text-pm-text-muted" />
                Import Environment
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* New Collection */}
          <button
            onClick={createCollection}
            title="New Collection"
            className="
              h-7
              w-7
              flex
              items-center
              justify-center
              rounded-md
              text-pm-text-muted
              hover:text-pm-text
              hover:bg-pm-hover
              transition-colors
            "
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Banner do modo "escolher pasta" (Convert to Flow) */}
      {folderPickMode && (
        <div className="mx-2 mb-2 flex items-center justify-between gap-2 rounded-md border border-pm-accent/40 bg-pm-accent/10 px-2.5 py-2 text-[11px] text-pm-text shrink-0">
          <span className="truncate">{pickerLabel ?? 'Select a folder'}</span>
          <button
            onClick={onCancelPicker}
            className="shrink-0 rounded p-0.5 text-pm-text-muted hover:text-pm-text hover:bg-pm-hover cursor-pointer"
            title="Cancel"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-hidden">
        <CollectionTree
          items={collections}
          activeRequestId={activeId}
          onRequestSelect={
            onRequestSelect
          }
          onUpdateItems={setCollections}
          onRename={onRenameItem}
          onRunItem={onRunCollection}
          onLoadTestItem={onLoadTestItem}
          onPushCollection={onPushCollection}
          onPullCollection={onPullCollection}
          onAddExampleItem={onAddExampleItem}
          folderPickMode={folderPickMode}
          onPickFolder={onPickFolder}
          collapseAllToken={collapseAllToken}
          pendingPushIds={pendingPushIds}
        />
      </div>
    </div>
  )
}