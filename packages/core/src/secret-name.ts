export const SECRET_NAME_EXPLANATION =
  'Use 1–128 uppercase letters, digits or underscores, starting with a letter or underscore. Reserved process and infrastructure names and prefixes (including AB_) are not allowed.'
const reserved =
  /^(?:AB_|XDG_|BASH_|ZSH_|PYTHON|PERL|RUBY|GEM_|JAVA_|JDK_|_JAVA_|DOCKER_|KUBE|CARGO_|RUSTC_|RUSTUP_|GITHUB_|GH_|VERCEL_|CRON_|DATABASE_|POSTGRES_|PG|AWS_|AZURE_|GOOGLE_|GCP_|S3_|BLOB_|R2_|UPSTASH_|REDIS_|NEON_|SUPABASE_|BETTER_AUTH_|NEXT_|NPM_|npm_|BUN_|NODE_|LD_|DYLD_|GIT_|SSH_|SSL_|CURL_|HTTP_|HTTPS_|ALL_PROXY|NO_PROXY)/i
const processNames = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'SHELLOPTS',
  'BASHOPTS',
  'COMSPEC',
  'PATHEXT',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'MANPAGER',
  'LESSOPEN',
  'LESSCLOSE',
  'INPUTRC',
  'ENV',
  'BASH_ENV',
  'ZDOTDIR',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'PWD',
  'IFS',
  'CDPATH',
  'NODE_EXTRA_CA_CERTS',
])
export function validateSecretName(name: unknown): asserts name is string {
  if (
    typeof name !== 'string' ||
    !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name) ||
    reserved.test(name) ||
    processNames.has(name)
  )
    throw new Error(SECRET_NAME_EXPLANATION)
}
