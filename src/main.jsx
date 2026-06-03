import { render } from 'preact'
import Redactor from './redactor.js'
import { registerSW } from 'virtual:pwa-register'

registerSW({ immediate: true })

render(<Redactor />, document.getElementById('app'))
