export const planningCommands = [
    {name:'!plan', description:'Show persistent goal, step progress and blocking reason.', perform:async agent => agent.taskPlan.summary()},
    {name:'!pausePlan', description:'Pause the persistent plan and stop the current action.', perform:async agent => {agent.taskPlan.pause(); await agent.actions.stop(); return agent.taskPlan.summary();}},
    {name:'!resumePlan', description:'Resume the existing plan after checking conditions; resets the decision budget.', perform:async agent => agent.taskPlan.resume()},
    {name:'!cancelPlan', description:'Cancel the persistent plan and stop the current action.', perform:async agent => {agent.taskPlan.pause('Cancelled by user','cancelled'); await agent.actions.stop(); return agent.taskPlan.summary();}},
    {name:'!finishStep', description:'Check current step completion. Manual criteria require specific observed evidence, recorded as model-reported.', params:{evidence:{type:'string',description:'Specific observed outcome; never just say done.'}}, perform:async (agent,evidence) => agent.taskPlan.finish(evidence)},
    {name:'!blockStep', description:'Pause a blocked step and explain the missing prerequisite or execution problem.', params:{reason:{type:'string',description:'What failed and what is needed to proceed.'}}, perform:async (agent,reason) => agent.taskPlan.pause(reason,'blocked')},
    {name:'!requestCode', description:'Request custom JavaScript ONLY for a capability unavailable through existing commands or their combination.', params:{reason:{type:'string',description:'Explain the specific missing capability. Typos, missing materials and pathfinding failures alone are not reasons.'}}, perform:async (agent,reason) => agent.taskPlan.allowCode(reason)}
];
