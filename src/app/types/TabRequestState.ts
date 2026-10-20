interface TabRequestState {
  isRequesting: boolean;
  startTime: number | null; 
  error: string | null;
  isDebugging: boolean;
  debugResult: string | null;
}