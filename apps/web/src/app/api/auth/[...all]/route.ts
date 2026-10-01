import { getAuth } from '@/lib/auth';

// better-auth owns every /api/auth/* route; disabled ones (public sign-up included) answer 404.
const handle = (request: Request) => getAuth().handler(request);

export { handle as GET, handle as POST };
