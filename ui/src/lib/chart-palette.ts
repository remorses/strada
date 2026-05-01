/**
 * Simple chart color tokens for agent-generated charts.
 * Agents can pass these names, omit colors for defaults, or pass any CSS color string.
 */

export const chartColors = {
  red: { light: '#e11624', dark: '#ff4d57' },
  rose: { light: '#ff3f4c', dark: '#ff6972' },
  amber: { light: '#f6a313', dark: '#ffbd45' },
  orange: { light: '#d37536', dark: '#e08b4d' },
  green: { light: '#00a63e', dark: '#31c76a' },
  blue: { light: '#4290f0', dark: '#6aa8ff' },
  purple: { light: '#8d58ee', dark: '#a67cff' },
  teal: { light: '#50c3b6', dark: '#6fd6cc' },
  gray: { light: '#7b818a', dark: '#a4a8ae' },
  black: { light: '#17181c', dark: '#d8dadd' },
} as const

export type ChartColorToken =
  | 'red'
  | 'rose'
  | 'amber'
  | 'orange'
  | 'green'
  | 'blue'
  | 'purple'
  | 'teal'
  | 'gray'
  | 'black'
export type ChartColor = ChartColorToken | (string & {})

const defaultChartColorTokens = ['blue', 'amber', 'rose', 'purple', 'teal', 'orange', 'green', 'gray'] as const

export function getChartColor(color: ChartColorToken, isDarkMode = false): string {
  return chartColors[color][isDarkMode ? 'dark' : 'light']
}

export function resolveChartColor({ color, index, isDarkMode = false }: { color?: ChartColor; index: number; isDarkMode?: boolean }): string {
  const token = color || defaultChartColorTokens[index % defaultChartColorTokens.length]
  const chartToken = toChartColorToken(token)
  if (chartToken) return getChartColor(chartToken, isDarkMode)
  return token
}

export function getDefaultChartColors(isDarkMode = false): string[] {
  return defaultChartColorTokens.map((color) => getChartColor(color, isDarkMode))
}

function toChartColorToken(value: string): ChartColorToken | undefined {
  switch (value) {
    case 'red': return 'red'
    case 'rose': return 'rose'
    case 'amber': return 'amber'
    case 'orange': return 'orange'
    case 'green': return 'green'
    case 'blue': return 'blue'
    case 'purple': return 'purple'
    case 'teal': return 'teal'
    case 'gray': return 'gray'
    case 'black': return 'black'
    default: return undefined
  }
}
