# Noushi Green — Design System do Tema TUI

Tema dark para a TUI do Noushi, inspirado na linguagem visual do [opencode.ai](https://opencode.ai/br): fundo grafite quase neutro, identidade toda em tons de verde, e vermelho/âmbar contidos apenas onde a função pede.

- **Arquivo do tema:** `src/modes/interactive/theme/noushi-green.json` (nome no setting: `noushi-green`, tema builtin)
- **Instalação:** selecionar em `/settings` — já vem embutido no Noushi. O watcher de arquivo recarrega a TUI sem restart.
- **Formato:** igual ao `dark.json` builtin — `vars` + `colors` em OKHSL, todos os tokens do catálogo.
- **Preview:** `docs/themes-preview.html` simula a TUI completa (editor funcional, tool calls, diff, thinking).

---

## 1. Direção visual

> "Grafite + verde": o terminal é quase monocromático; o verde é a única voz.

- **Fundo:** cinza grafite com sopro verde muito sutil (`okhsl(160 5–6%)`) — equivalente ao `#0c0c0c` do opencode. Fundos de superfície (mensagens, caixas) sobem ~7 pontos de L, nunca mais.
- **Identidade:** verde-menta `okhsl(152 60% 68%)` como accent; links em teal `okhsl(175 45% 62%)`; código e diffs na família 155–160.
- **Contenção:** erro vermelho e warning âmbar só aparecem em estados de função (erro de tool, warning, degrau máximo de thinking). Nenhum token "decorativo" usa essas cores.
- **Texto:** neutro esverdeado muito leve (`okhsl(150 3%)`), corpo em L 92%, secundário em 67%.

## 2. Vars (paleta)

| Var | Valor | Papel |
|---|---|---|
| `text` | `okhsl(150 3% 92%)` | corpo de texto |
| `muted` | `okhsl(150 5% 67%)` | texto secundário, output de tool |
| `dim` | `okhsl(160 4% 54%)` | texto terciário, hints |
| `mint` | `okhsl(152 60% 68%)` | accent — seleção, labels, código inline |
| `teal` | `okhsl(175 45% 62%)` | links, keywords de sintaxe |
| `green` | `okhsl(159 59% 67%)` | sucesso, diffs +, números |
| `olive` | `okhsl(95 40% 67%)` | strings |
| `amber` | `okhsl(75 75% 67%)` | warning, funções |
| `red` | `okhsl(18 72% 66%)` | erro, diffs − |
| `graphite` | `okhsl(160 5% 15%)` | superfície elevada |
| `graphiteBg` | `okhsl(160 6% 21%)` | bolha do usuário, seleção, tool pendente |

## 3. Grupos de tokens

### Base
`accent` mint · `text` text · `muted` muted · `dim` dim · `border` okhsl(160 8% 52%) · `borderAccent` mint −5L · `borderMuted` okhsl(160 4% 46%)

### Estado
`success` green · `error` red · `warning` amber

### Caixas de tool
- `toolPendingBg` grafite okhsl(160 5% 21%)
- `toolSuccessBg` okhsl(158 45% 24%) — verde escuro
- `toolErrorBg` okhsl(18 50% 24%) — vermelho escuro
- `toolTitle` text · `toolOutput` muted

### Mensagens
`userMessageBg` graphiteBg · `userMessageText` text · `customMessageBg` okhsl(152 18% 20%) · `customMessageLabel` mint

### Markdown
`mdHeading` mint · `mdLink` teal · `mdCode` mint · `mdCodeBlock` green · bullets em mint · quotes em muted

### Diff
`toolDiffAdded` green · `toolDiffRemoved` red · `toolDiffContext` muted · diff intra-linha com inverse

### Sintaxe
| Token | Cor | Racional |
|---|---|---|
| `syntaxKeyword` | teal | estruturas — frio, discreto |
| `syntaxString` | olive | aquece sem gritar |
| `syntaxFunction` | amber | único acento quente do código |
| `syntaxType` | mint | alinhado ao accent |
| `syntaxNumber` | green | |
| `syntaxVariable` | okhsl(140 35% 72%) | verde-claro dessaturado |
| comentário/operador/pontuação | muted | recuo visual |

### Thinking (escala de 7 bordas do editor)
Sobe do cinza pelo verde e esquenta no fim, para o degrau máximo ficar óbvio:

```
off      okhsl(160  8% 49%)   cinza
minimal  okhsl(160 12% 52%)
low      okhsl(150 30% 54%)   verde entra
medium   okhsl(152 45% 57%)
high     okhsl(155 55% 60%)   verde pleno
xhigh    okhsl( 60 65% 62%)   âmbar
max      okhsl( 40 90% 62%)   laranja
```

`bashMode` mantém o verde do tema: okhsl(159 64% 65%).

## 4. Regras de contraste

- Todos os tokens de texto ficam em L ≥ 54% sobre fundos ≤ L 26% (contraste folgado).
- Accent e cores vivas ficam em L 62–68% — o mesmo princípio do dark builtin ("acento em L 67% é legível por construção").
- Fundos de estado (success/error/pending) ficam em L 21–24%: distinguem o estado sem competir com o texto.

## 5. Exportação

`pageBg` okhsl(160 6% 10%) · `cardBg` okhsl(160 5% 14%) · `infoBg` okhsl(140 40% 22%)

## 6. Referência de conversão

Para protótipos HTML, os valores OKHSL mapeiam para OKLCH `(L% C H°)` mantendo a mesma luminosidade percebida; o preview usa exatamente esses equivalentes.
