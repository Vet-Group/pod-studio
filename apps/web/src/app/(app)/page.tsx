import { redirect } from 'next/navigation';
import { HOME_SCREEN } from '@/lib/screens';

export default function Home() {
  redirect(`/${HOME_SCREEN.slug}`);
}
