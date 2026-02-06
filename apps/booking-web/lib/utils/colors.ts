function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      case b:
        h = ((r - g) / d + 4) / 6
        break
    }
  }

  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)]
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

export function generateColorPalette(hex: string): Record<string, string> {
  const [h, s] = hexToHsl(hex)

  const shades: [string, number][] = [
    ['50', 96],
    ['100', 92],
    ['200', 84],
    ['300', 72],
    ['400', 58],
    ['500', 48],
    ['600', 40],
    ['700', 33],
    ['800', 26],
    ['900', 20],
  ]

  const palette: Record<string, string> = {}
  for (const [shade, lightness] of shades) {
    const adjustedSat = lightness > 80 ? Math.round(s * 0.6) : lightness > 60 ? Math.round(s * 0.8) : s
    palette[shade] = hslToHex(h, adjustedSat, lightness)
  }

  return palette
}
