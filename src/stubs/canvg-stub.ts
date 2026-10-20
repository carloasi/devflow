// Stub pro pacote "canvg" — jsPDF só usa ele pra renderizar SVG dentro de
// PDF (addSvgAsImage/.html()), recurso que este app não usa (o relatório de
// load test é só texto/tabelas). O canvg real puxa "core-js" (dezenas de
// arquivos "internals/*"), e nesse ambiente o registry/cache do npm tem
// entregado esse pacote corrompido de forma consistente (arquivos internos
// faltando, sempre um diferente a cada reinstall), quebrando o build mesmo
// sem essa funcionalidade jamais ser chamada em runtime.
//
// Esse alias (ver next.config.ts, turbopack.resolveAlias) faz o bundler
// nunca precisar resolver o canvg de verdade — só esse stub, que não
// depende de core-js nem de mais nada. Se algum dia o app precisar
// realmente embutir SVG em PDF, é só remover o alias e reinstalar o canvg.
export default {
  fromString() {
    return {
      render() {
        return Promise.reject(
          new Error('SVG-to-PDF rendering is not available in this build (canvg is stubbed out).')
        )
      },
    }
  },
}
