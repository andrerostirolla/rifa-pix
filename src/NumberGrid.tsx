type Props = {
  numbers: number[]
  sold: Set<number>
  selected?: Set<number>
  onToggle?: (n: number) => void
  selectableOnlyAvailable?: boolean
}

export function NumberGrid({ numbers, sold, selected, onToggle, selectableOnlyAvailable = true }: Props) {
  if (!numbers.length) {
    return <p className="empty">Nenhum número atribuído a você neste evento.</p>
  }

  return (
    <div className="number-grid" role="list">
      {numbers.map((n) => {
        const isSold = sold.has(n)
        const isSelected = selected?.has(n)
        const clickable = Boolean(onToggle) && (!selectableOnlyAvailable || !isSold)
        return (
          <button
            key={n}
            type="button"
            role="listitem"
            className={`num-cell ${isSold ? 'sold' : 'free'} ${isSelected ? 'selected' : ''}`}
            disabled={!clickable}
            onClick={() => clickable && onToggle?.(n)}
            title={isSold ? 'Vendido' : 'Disponível'}
          >
            {String(n).padStart(2, '0')}
          </button>
        )
      })}
    </div>
  )
}
