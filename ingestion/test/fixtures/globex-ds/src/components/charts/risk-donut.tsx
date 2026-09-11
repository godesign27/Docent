import { Card } from "@/components/ui/card"

/** "% High Risk" gauge with the value centered. */
export function RiskDonut({ value, label }: { value: number; label: string }) {
  return (
    <Card>
      <svg role="img" aria-label={`${label}: ${value}%`} className="text-brand-teal" />
    </Card>
  )
}
