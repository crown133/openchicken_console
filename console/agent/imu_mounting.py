"""Explicit signed-axis mounting only. No mounting is inferred from tilt recordings."""
from agent.attitude_filter import vector

DIRECTIONS = {'forward':[1,0,0], 'backward':[-1,0,0],
              'left':[0,1,0], 'right':[0,-1,0], 'up':[0,0,1], 'down':[0,0,-1]}


def rotation(directions):
    if not isinstance(directions,dict) or set(directions) != {'x','y','z'}:
        raise ValueError('sensor +x,+y,+z mounting directions required')
    try:columns=[DIRECTIONS[directions[axis]] for axis in ['x','y','z']]
    except (KeyError,TypeError):raise ValueError('unknown mounting direction') from None
    r=[[col[row] for col in columns] for row in range(3)]
    determinant=(r[0][0]*(r[1][1]*r[2][2]-r[1][2]*r[2][1])-
                 r[0][1]*(r[1][0]*r[2][2]-r[1][2]*r[2][0])+
                 r[0][2]*(r[1][0]*r[2][1]-r[1][1]*r[2][0]))
    if determinant != 1:raise ValueError('mounting axes must be orthogonal and right-handed')
    return r


def transform(r,v):
    if not vector(v):raise ValueError('finite three-vector required')
    return [sum(a*b for a,b in zip(row,v)) for row in r]

