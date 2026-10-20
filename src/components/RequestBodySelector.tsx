'use client'

import { useMemo, useState } from "react";
import { Copy, Check } from "lucide-react";
import HttpBodyEditor from "./HttpBodyEditor";
import { parse, format, ParseError } from "jsonc-parser";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

type BodyType = "none" | "raw" | "graphql";

interface RequestBodyEditorProps {
    bodyType: BodyType;
    setBodyType: (type: BodyType) => void;
    bodyValue: string;
    setBodyValue: (value: string) => void;
    tabId: string;
}

interface ParsedGraphQLBody {
    query: string;
    variables: string;
}

// O body de uma request GraphQL fica guardado como um único JSON serializado
// ({ query, variables }) dentro de requestBodyValue — sem precisar mexer no
// schema de Tab/CollectionItem, que só tem um campo `body: string`.
// `variables` fica salvo como STRING bruta (não parseada), pra preservar
// exatamente o que o usuário digitou (incluindo JSON temporariamente inválido
// enquanto ele ainda está escrevendo) sem reformatar a cada tecla.
function parseGraphQLBody(raw: string): ParsedGraphQLBody {
    if (!raw || !raw.trim()) return { query: "", variables: "{}" };

    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.query === "string") {
            const variables =
                typeof parsed.variables === "string"
                    ? parsed.variables
                    : parsed.variables !== undefined
                    ? JSON.stringify(parsed.variables, null, 2)
                    : "{}";
            return { query: parsed.query, variables };
        }
    } catch {
        // não era JSON — cai no fallback abaixo
    }

    // Qualquer outro formato (body "raw" anterior, JSON não relacionado, texto
    // puro): preserva como a query, pra nunca perder o que já estava escrito
    // só por causa da troca de aba.
    return { query: raw, variables: "{}" };
}

function serializeGraphQLBody(query: string, variables: string): string {
    return JSON.stringify({ query, variables });
}

export default function RequestBodyEditor({
    bodyType,
    setBodyType,
    bodyValue,
    setBodyValue,
    tabId,
}: RequestBodyEditorProps) {
    const [isValidJson, setIsValidJson] = useState(true);
    const [copiedTarget, setCopiedTarget] = useState<"raw" | "query" | "variables" | null>(null);

    const copyToClipboard = async (text: string, target: "raw" | "query" | "variables") => {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            setCopiedTarget(target);
            setTimeout(() => setCopiedTarget(prev => (prev === target ? null : prev)), 1500);
        } catch (err) {
            console.error("Failed to copy body content:", err);
        }
    };

    const graphqlBody = useMemo(() => parseGraphQLBody(bodyValue), [bodyValue]);

    const isGraphQLVariablesValidJson = useMemo(() => {
        const trimmed = graphqlBody.variables.trim();
        if (!trimmed) return true;
        try {
            JSON.parse(trimmed);
            return true;
        } catch {
            return false;
        }
    }, [graphqlBody.variables]);

    const updateGraphQLQuery = (newQuery: string) => {
        setBodyValue(serializeGraphQLBody(newQuery, graphqlBody.variables));
    };

    const updateGraphQLVariables = (newVariables: string) => {
        setBodyValue(serializeGraphQLBody(graphqlBody.query, newVariables));
    };

    // Função para validar e formatar o JSON (Beautify)
    const formatJSON = () => {
        if (!bodyValue.trim()) return;

        const errors: ParseError[] = [];
        parse(bodyValue, errors, { allowTrailingComma: true, disallowComments: false });

        if (errors.length > 0) {
            setIsValidJson(false);
            return;
        }

        const edits = format(bodyValue, undefined, {
            tabSize: 2,
            insertSpaces: true,
            eol: '\n',
        });

        let formatted = bodyValue;
        for (let i = edits.length - 1; i >= 0; i--) {
            const edit = edits[i];
            formatted =
                formatted.slice(0, edit.offset) +
                edit.content +
                formatted.slice(edit.offset + edit.length);
        }

        setBodyValue(formatted);
        setIsValidJson(true);
    };

    return (
        <div className="h-full flex flex-col overflow-hidden flex-1 w-full font-sans antialiased text-pm-text">
            <div className="flex items-center justify-between px-3 h-9 bg-pm-bg select-none shrink-0">
                <div className="flex items-center gap-1 h-full">
                    {/* Aba: none */}
                    <button
                        type="button"
                        onClick={() => setBodyType("none")}
                        className={`px-3 h-full text-xs font-medium cursor-pointer transition-colors relative flex items-center ${
                            bodyType === "none"
                                ? "text-pm-text font-semibold after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-pm-accent"
                                : "text-pm-text-muted hover:text-pm-text"
                        }`}
                    >
                        none
                    </button>

                    {/* Aba: raw */}
                    <button
                        type="button"
                        onClick={() => setBodyType("raw")}
                        className={`px-3 h-full text-xs font-medium cursor-pointer transition-colors relative flex items-center ${
                            bodyType === "raw"
                                ? "text-pm-text font-semibold after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-pm-accent"
                                : "text-pm-text-muted hover:text-pm-text"
                        }`}
                    >
                        raw
                    </button>

                    {/* Aba: GraphQL */}
                    <button
                        type="button"
                        onClick={() => setBodyType("graphql")}
                        className={`px-3 h-full text-xs font-medium cursor-pointer transition-colors relative flex items-center ${
                            bodyType === "graphql"
                                ? "text-pm-text font-semibold after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-pm-accent"
                                : "text-pm-text-muted hover:text-pm-text"
                        }`}
                    >
                        GraphQL
                    </button>

                    {/* Selector / Status do JSON (Postman Style) */}
                    {bodyType === "raw" && (
                        <div className="flex items-center h-4 ml-2 pl-3 border-l border-pm-border">
                            <span
                                className={`text-[11px] font-semibold tracking-tight px-1.5 py-0.5 rounded ${
                                    isValidJson
                                        ? "text-[#68b684] bg-[#68b684]/10"
                                        : "text-[#f25c54] bg-[#f25c54]/10 animate-pulse"
                                }`}
                            >
                                {isValidJson ? "JSON" : "Invalid JSON"}
                            </span>
                        </div>
                    )}

                    {bodyType === "graphql" && (
                        <div className="flex items-center h-4 ml-2 pl-3 border-l border-pm-border">
                            <span
                                className={`text-[11px] font-semibold tracking-tight px-1.5 py-0.5 rounded ${
                                    isGraphQLVariablesValidJson
                                        ? "text-[#68b684] bg-[#68b684]/10"
                                        : "text-[#f25c54] bg-[#f25c54]/10 animate-pulse"
                                }`}
                            >
                                {isGraphQLVariablesValidJson ? "Variables OK" : "Invalid Variables JSON"}
                            </span>
                        </div>
                    )}
                </div>

                {/* Botões Copy / Beautify */}
                {bodyType === "raw" && bodyValue.trim() && (
                    <div className="flex items-center gap-1.5">
                        <button
                            onClick={() => copyToClipboard(bodyValue, "raw")}
                            title="Copy body to clipboard"
                            className="flex items-center gap-1 text-[11px] font-medium cursor-pointer bg-pm-hover hover:bg-pm-row-active active:bg-pm-row-active text-pm-text px-2.5 py-1 rounded border border-pm-border transition-colors shadow-sm"
                        >
                            {copiedTarget === "raw" ? (
                                <>
                                    <Check size={11} className="text-[#68b684]" /> Copied
                                </>
                            ) : (
                                <>
                                    <Copy size={11} /> Copy
                                </>
                            )}
                        </button>
                        <button
                            onClick={formatJSON}
                            className="text-[11px] font-medium cursor-pointer bg-pm-hover hover:bg-pm-row-active active:bg-pm-row-active text-pm-text px-2.5 py-1 rounded border border-pm-border transition-colors shadow-sm"
                        >
                            Beautify
                        </button>
                    </div>
                )}
            </div>

            {/* Editor Container */}
            <div
                className={`flex flex-col flex-1 bg-pm-bg overflow-hidden transition-colors ${
                    !isValidJson && bodyType === "raw"
                        ? "ring-1 ring-inset ring-[#f25c54]/50"
                        : ""
                }`}
            >
                {bodyType === "none" && (
                    <div className="flex-1 flex flex-col items-center justify-center text-pm-text-muted text-xs select-none">
                        <svg className="w-7 h-7 mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                        </svg>
                        <span>This request does not have a body</span>
                    </div>
                )}

                {bodyType === "raw" && (
                    <div className="flex-1 flex flex-col h-full w-full relative">
                        <HttpBodyEditor
                            type={bodyType}
                            value={bodyValue}
                            tabId={tabId}
                            onChange={(val) => {
                                setBodyValue(val || "");
                                if (!isValidJson) setIsValidJson(true);
                            }}
                        />
                    </div>
                )}

                {bodyType === "graphql" && (
                    <ResizablePanelGroup orientation="vertical" className="flex-1 min-h-0">
                        <ResizablePanel defaultSize={65} minSize={25} className="flex flex-col min-h-0">
                            <div className="px-3 py-1 flex items-center justify-between bg-pm-surface border-b border-pm-border shrink-0">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-pm-text-muted">
                                    Query
                                </span>
                                {graphqlBody.query.trim() && (
                                    <button
                                        onClick={() => copyToClipboard(graphqlBody.query, "query")}
                                        title="Copy query to clipboard"
                                        className="flex items-center gap-1 text-[10px] font-medium cursor-pointer text-pm-text-muted hover:text-pm-text transition-colors"
                                    >
                                        {copiedTarget === "query" ? (
                                            <>
                                                <Check size={10} className="text-[#68b684]" /> Copied
                                            </>
                                        ) : (
                                            <>
                                                <Copy size={10} /> Copy
                                            </>
                                        )}
                                    </button>
                                )}
                            </div>
                            <div className="flex-1 flex flex-col w-full relative min-h-0">
                                <HttpBodyEditor
                                    type="graphql"
                                    value={graphqlBody.query}
                                    tabId={`${tabId}-gql-query`}
                                    onChange={(val) => updateGraphQLQuery(val || "")}
                                />
                            </div>
                        </ResizablePanel>

                        <ResizableHandle />

                        <ResizablePanel defaultSize={35} minSize={15} className="flex flex-col min-h-0">
                            <div className="px-3 py-1 flex items-center justify-between bg-pm-surface border-b border-pm-border shrink-0">
                                <span className="text-[10px] font-semibold uppercase tracking-wider text-pm-text-muted">
                                    Variables
                                </span>
                                <div className="flex items-center gap-2">
                                    {!isGraphQLVariablesValidJson && (
                                        <span className="text-[10px] font-semibold text-[#f25c54]">Invalid JSON</span>
                                    )}
                                    {graphqlBody.variables.trim() && (
                                        <button
                                            onClick={() => copyToClipboard(graphqlBody.variables, "variables")}
                                            title="Copy variables to clipboard"
                                            className="flex items-center gap-1 text-[10px] font-medium cursor-pointer text-pm-text-muted hover:text-pm-text transition-colors"
                                        >
                                            {copiedTarget === "variables" ? (
                                                <>
                                                    <Check size={10} className="text-[#68b684]" /> Copied
                                                </>
                                            ) : (
                                                <>
                                                    <Copy size={10} /> Copy
                                                </>
                                            )}
                                        </button>
                                    )}
                                </div>
                            </div>
                            <div
                                className={`flex-1 flex flex-col w-full relative min-h-0 transition-colors ${
                                    !isGraphQLVariablesValidJson ? "ring-1 ring-inset ring-[#f25c54]/50" : ""
                                }`}
                            >
                                <HttpBodyEditor
                                    type="raw"
                                    value={graphqlBody.variables}
                                    tabId={`${tabId}-gql-vars`}
                                    onChange={(val) => updateGraphQLVariables(val || "")}
                                />
                            </div>
                        </ResizablePanel>
                    </ResizablePanelGroup>
                )}
            </div>
        </div>
    );
}
