import { loader } from '@monaco-editor/react';

// Pin do build do Monaco, carregado do CDN.
//
// Fica num módulo próprio porque `loader.config` só vale ANTES de o Monaco
// inicializar: quando a chamada morava dentro do HttpBodyEditor, qualquer
// outro editor que montasse primeiro (os blocos do Collection Runner, por
// exemplo) subia o Monaco na versão padrão do pacote, e a versão que o app
// usava passava a depender da ordem de montagem da tela.
//
// Como efeito colateral de módulo, roda uma vez só por bundle — basta
// importar este arquivo antes de renderizar qualquer editor.
loader.config({
  paths: {
    vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs',
  },
});

export {};
