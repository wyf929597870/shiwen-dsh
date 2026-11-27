import React from 'react';

const paths={
  home:'M3 10.5 12 3l9 7.5V21h-6v-7H9v7H3z',
  chat:'M20.5 11a8.5 8.5 0 0 1-8.5 8.5H8l-5 2v-9A8.75 8.75 0 1 1 20.5 11Z',
  notes:'m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  global:'M20.5 20.5 16 16M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z',
  model:'M5 6h14v13H5zM9 3v3m6-3v3M9 19v2m6-2v2M2 10h3m14 0h3M2 15h3m14 0h3M9 10h6v5H9z',
  settings:'M3 6h6m4 0h8M3 12h11m4 0h3M3 18h3m4 0h11M9 3.5h4v5H9zM14 9.5h4v5h-4zM6 15.5h4v5H6z',
  refresh:'M20 5v5h-5M20 10a8 8 0 1 0-.8 6',
  plus:'M12 4v16M4 12h16', close:'M5 5l14 14M19 5 5 19',
  filter:'M3.5 6h17M6.5 12h11M10 18h4'
};
export function PhoneIcon({name,size=20}){
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
