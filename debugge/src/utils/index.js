export const formatTime = (value, type = 'YYYY-MM-DD hh:mm:ss') => {
  if (!['string', 'number', 'object'].includes(typeof value)) {
    return new Error('params type error')
  }
  if (!(value instanceof Date)) {
    value = new Date(value)
  }
  console.log(value)
}
