export type Result<T, E = Error> = 
  | { readonly success: true; readonly data: T } 
  | { readonly success: false; readonly error: E };
