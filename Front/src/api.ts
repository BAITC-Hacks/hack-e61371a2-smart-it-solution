export type Role='employee'|'manager'|'hr'|'admin';
export type User={id:string;login:string;displayName:string;role:Role;employeeId:string|null;demo:boolean};
export type Session={user:User;csrfToken:string};
export type Employee={id:string;name:string;role:string;grade:string;department:string;language:string};
export type Profile=Employee&{managerId:string|null;hireDate:string;tenureMonths:number;workFormat:string;lastReviewDate:string;targetRole:string|null;targetGrade:string|null};
export type Workspace={counts:{employees:number;skills:number;events:number;participations:number};dataset:{version:string;asOfDate:string;importedAt:string}|null;scope:string};
export class ApiError extends Error {constructor(message:string,public status:number,public details?:{file?:string;field?:string;message:string}[]){super(message);}}
export async function api<T>(path:string,options:{method?:string;body?:unknown;csrf?:string;signal?:AbortSignal}={}) {
  const response=await fetch(`${import.meta.env.VITE_API_BASE_URL??'/api/v1'}${path}`,{method:options.method??'GET',credentials:'same-origin',signal:options.signal,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.csrf?{'X-CSRF-Token':options.csrf}:{})},body:options.body?JSON.stringify(options.body):undefined});
  const payload=await response.json().catch(()=>null);
  if(!response.ok){
    if(response.status===401&&!path.startsWith('/auth/'))window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(payload?.error?.message??'Сервер недоступен. Повторите попытку.',response.status,payload?.error?.details);
  }
  return payload as {data:T;meta?:{total:number;page:number;limit:number}};
}
