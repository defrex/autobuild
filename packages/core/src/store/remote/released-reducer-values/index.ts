// Generated release catalog registry. Historical catalogs are immutable evidence.
import release0 from './1.10.0.json'
import release1 from './1.11.0.json'
import release2 from './1.2.0.json'
import release3 from './1.3.0.json'
import release4 from './1.4.0.json'
import release5 from './1.5.0.json'
import release6 from './1.6.0.json'
import release7 from './1.7.0.json'
import release8 from './1.8.0.json'
import release9 from './1.9.0.json'
import type { ReducerValueCatalog } from '../../reducer-value-validation'
export interface ReleasedReducerValues extends ReducerValueCatalog {
  versions: Record<string, number>
}
export const RELEASED_REDUCER_VALUES: Readonly<Record<string, ReleasedReducerValues>> = {
  '1.10.0.json': release0,
  '1.11.0.json': release1,
  '1.2.0.json': release2,
  '1.3.0.json': release3,
  '1.4.0.json': release4,
  '1.5.0.json': release5,
  '1.6.0.json': release6,
  '1.7.0.json': release7,
  '1.8.0.json': release8,
  '1.9.0.json': release9,
}
