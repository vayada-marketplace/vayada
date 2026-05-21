export function addToList(
  list: string[],
  setList: (v: string[]) => void,
  value: string,
  clearInput: (v: string) => void
) {
  if (!value.trim()) return
  setList([...list, value.trim()])
  clearInput('')
}

export function removeFromList(
  list: string[],
  setList: (v: string[]) => void,
  index: number
) {
  setList(list.filter((_, i) => i !== index))
}
