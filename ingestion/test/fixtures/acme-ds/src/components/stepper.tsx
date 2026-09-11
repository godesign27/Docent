import { useStepper } from "@/hooks/use-stepper"

export function StepperList(props) {
  return <ol {...props} />
}

export const StepperItem = ({ active }: { active?: boolean }) => <li data-active={active} />
