// Cidade preferida da seção "Perto de você" da home. Gravada pela busca (cidade
// escolhida nas sugestões) ou por "Usar minha localização". Sem "server-only":
// a busca grava o cookie no navegador.

export const CITY_COOKIE = "eb_city";
/** "localizacao" quando a cidade veio da posição do navegador; ausente quando foi escolhida na busca. */
export const CITY_SOURCE_COOKIE = "eb_city_origem";
