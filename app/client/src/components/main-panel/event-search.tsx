import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useUIStore } from '@/stores/ui-store'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export function EventSearch() {
  const { searchQuery, setSearchQuery } = useUIStore()
  const [localSearch, setLocalSearch] = useState(searchQuery)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    setLocalSearch(searchQuery)
  }, [searchQuery])

  function handleSearchChange(value: string) {
    setLocalSearch(value)
    clearTimeout(debounceRef.current)
    if (value === '') {
      setSearchQuery('')
    } else {
      debounceRef.current = setTimeout(() => setSearchQuery(value), 350)
    }
  }

  return (
    <div className="relative w-48 shrink-0">
      <Search
        className={cn(
          'absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5',
          localSearch ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground',
        )}
      />
      <Input
        data-region-target="search"
        placeholder="Search events..."
        value={localSearch}
        onChange={(e) => handleSearchChange(e.target.value)}
        className={cn(
          'h-7 pl-7 text-xs',
          localSearch &&
            'border-green-600 dark:border-green-400 ring-1 ring-green-600/30 dark:ring-green-400/30',
          localSearch && localSearch !== localSearch.trim() && 'bg-green-600/5 dark:bg-green-400/5',
          localSearch && 'pr-7',
        )}
      />
      {localSearch && (
        <button
          onClick={() => handleSearchChange('')}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 h-4 w-4 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
