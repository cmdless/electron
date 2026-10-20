import { Text } from '@mantine/core'
import { ScreenLayout } from '../layout'

export default function Placeholder({ title, text }: { title: string; text: string }) {
  return <ScreenLayout title={title}><Text c="dimmed">{text}</Text></ScreenLayout>
}
